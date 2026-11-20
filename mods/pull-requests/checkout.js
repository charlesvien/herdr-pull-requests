import { exec, spaces, panes, home, appHome, readTextFile } from "herdr";

async function git(cwd, args, timeout) {
  try {
    const result = await exec("git", args, { cwd, ...(timeout ? { timeout } : {}) });
    return { ok: result.code === 0, out: (result.stdout ?? "").trim(), err: (result.stderr || result.stdout || "").trim() };
  } catch (error) {
    return { ok: false, out: "", err: String(error?.message ?? error) };
  }
}

const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
const slugOf = (remote) => remote.replace(/\.git$/, "").match(/github\.com[:/]([^/]+\/[^/]+)$/i)?.[1].toLowerCase() ?? null;
const folderName = (branch) => branch.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "branch";

async function mainOf(folder) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.ok && common.out.endsWith("/.git") ? common.out.slice(0, -5) : null;
}

async function worktrees(main) {
  const list = await git(main, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return [];
  return list.out.split(/\n\n+/).flatMap((block) => {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((line) => line === "bare" || line.startsWith("prunable"))) return [];
    return [{ path, branch: lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null }];
  });
}

async function worktreeRoot() {
  let directory = "~/.herdr/worktrees";
  try {
    directory = JSON.parse((await readTextFile(`${appHome()}/settings.json`)) ?? "{}")?.worktrees?.directory || directory;
  } catch {}
  return (directory === "~" || directory.startsWith("~/") ? home() + directory.slice(1) : directory).replace(/\/+$/, "");
}

export function spaceFolder(space, paneList) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  return paneList.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder || null;
}

function spaceAt(path, all) {
  const paneList = panes();
  return spaces().find((space) => {
    if (space.machine) return false;
    const at = spaceFolder(space, paneList);
    return Boolean(at) && inside(at, path) && !all.some((other) => other.path.length > path.length && inside(at, other.path));
  });
}

export class Checkouts {
  constructor() {
    this.mains = new Map();
  }

  async main(repo) {
    const wanted = repo.toLowerCase();
    if (this.mains.has(wanted)) return this.mains.get(wanted);
    const local = [...panes().filter((pane) => !pane.pane.includes("/")).map((pane) => pane.cwd), ...spaces().filter((space) => !space.machine).map((space) => space.folder)];
    const mains = new Set();
    for (const folder of new Set(local.filter(Boolean))) {
      const main = await mainOf(folder);
      if (main) mains.add(main);
    }
    for (const main of [...mains]) {
      const sibling = `${main.slice(0, main.lastIndexOf("/"))}/${repo.split("/")[1]}`;
      if (!mains.has(sibling) && (await mainOf(sibling)) === sibling) mains.add(sibling);
    }
    for (const main of mains) {
      const origin = await git(main, ["remote", "get-url", "origin"]);
      const slug = origin.ok ? slugOf(origin.out) : null;
      if (slug) this.mains.set(slug, main);
    }
    return this.mains.get(wanted) ?? null;
  }

  async prepare(pr) {
    const main = await this.main(pr.repo);
    if (!main) throw new Error(`No local checkout of ${pr.repo} found. Open a space in it once, then try again.`);
    const all = await worktrees(main);
    const existing = all.find((worktree) => worktree.branch === pr.head);
    if (existing) return { path: existing.path, space: spaceAt(existing.path, all), created: false };

    const path = `${await worktreeRoot()}/${main.split("/").pop()}/${folderName(pr.head)}`;
    let add = ["worktree", "add", path, pr.head];
    if (!(await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${pr.head}`])).ok) {
      const fetched = await git(main, ["fetch", "origin", pr.fork ? `pull/${pr.number}/head` : pr.head], 120000);
      if (!fetched.ok) throw new Error(fetched.err || "git fetch failed");
      add = pr.fork ? ["worktree", "add", "-b", pr.head, path, "FETCH_HEAD"] : ["worktree", "add", "--track", "-b", pr.head, path, `origin/${pr.head}`];
    }
    const added = await git(main, add, 600000);
    if (!added.ok) throw new Error(added.err || "git worktree add failed");
    return { path, space: undefined, created: true };
  }
}
