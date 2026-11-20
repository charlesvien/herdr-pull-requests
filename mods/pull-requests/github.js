import { exec } from "herdr";

const SEARCH = "is:pr is:open author:@me archived:false";

const FIELDS = `id number title url isDraft isCrossRepository createdAt updatedAt baseRefName headRefName
repository { nameWithOwner } author { login } reviewDecision
reviewThreads(first: 50) { nodes { isResolved } }
commits(last: 1) { nodes { commit { statusCheckRollup { state contexts {
  totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
} } } } }`;
const LIST = `query($q: String!) { search(query: $q, type: ISSUE, first: 60) { nodes { ... on PullRequest { ${FIELDS} } } } }`;
// mergeable alone takes GitHub several seconds, so it loads beside the list instead of inside it.
const MERGEABLE = `query($q: String!) { search(query: $q, type: ISSUE, first: 60) { nodes { ... on PullRequest { id mergeable } } } }`;

const PASSED = new Set(["SUCCESS", "SKIPPED", "NEUTRAL", "COMPLETED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const REVIEWS = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "required" };

async function gh(args) {
  let result;
  try {
    result = await exec("gh", args, { timeout: 30000 });
  } catch (error) {
    throw new Error(`Couldn't run gh: ${error?.message ?? error}`);
  }
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || `gh ${args[0]} failed`);
  return result.stdout;
}

async function gql(query, q) {
  return JSON.parse(await gh(["api", "graphql", "-f", `q=${q}`, "-f", `query=${query}`])).data;
}

export async function commentOnAll(prs, body, onProgress) {
  const queue = [...prs];
  const failed = [];
  let done = 0;
  const worker = async () => {
    for (let pr = queue.shift(); pr; pr = queue.shift()) {
      try {
        await gh(["pr", "comment", pr.url, "--body", body]);
      } catch (error) {
        failed.push({ pr, error: String(error?.message ?? error) });
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return failed;
}

function checksOf(rollup) {
  if (!rollup) return { state: "none", total: 0, passed: 0, failed: 0 };
  const contexts = rollup.contexts ?? {};
  let passed = 0;
  let failed = 0;
  for (const { state, count } of [...(contexts.checkRunCountsByState ?? []), ...(contexts.statusContextCountsByState ?? [])]) {
    if (PASSED.has(state)) passed += count;
    else if (FAILED.has(state)) failed += count;
  }
  const state = rollup.state === "SUCCESS" ? "passing" : rollup.state === "FAILURE" || rollup.state === "ERROR" ? "failing" : "running";
  return { state, total: contexts.totalCount ?? passed + failed, passed, failed };
}

function toPr(node, conflicts) {
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository.nameWithOwner,
    author: node.author?.login ?? "ghost",
    draft: node.isDraft,
    fork: node.isCrossRepository,
    created: Date.parse(node.createdAt),
    updated: Date.parse(node.updatedAt),
    base: node.baseRefName,
    head: node.headRefName,
    review: REVIEWS[node.reviewDecision] ?? "none",
    threads: (node.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved).length,
    checks: checksOf(node.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    conflicts,
  };
}

export async function fetchPrs() {
  const [list, merge] = await Promise.all([gql(LIST, SEARCH), gql(MERGEABLE, SEARCH).catch(() => null)]);
  const conflicting = new Set((merge?.search.nodes ?? []).filter((node) => node.mergeable === "CONFLICTING").map((node) => node.id));
  return list.search.nodes.filter((node) => node.id).map((node) => toPr(node, conflicting.has(node.id)));
}

export const attention = (pr) => pr.checks.state === "failing" || pr.review === "changes" || pr.conflicts;
export const needsReview = (pr) => pr.review === "required" && !pr.draft;
export const ready = (pr) => pr.review === "approved" && !pr.draft && !pr.conflicts && (pr.checks.state === "passing" || pr.checks.state === "none");
export const fixable = (pr) => attention(pr) || pr.threads > 0;

export function arrange(prs, sort, match) {
  const byHead = new Map(prs.filter((pr) => !pr.fork).map((pr) => [`${pr.repo}:${pr.head}`, pr]));
  const children = new Map();
  const roots = [];
  for (const pr of prs) {
    const parent = byHead.get(`${pr.repo}:${pr.base}`);
    if (parent && parent !== pr) children.set(parent.id, [...(children.get(parent.id) ?? []), pr]);
    else roots.push(pr);
  }

  const seen = new Set();
  const stackFrom = (root) => {
    const stack = [];
    const walk = (pr, depth) => {
      if (seen.has(pr.id)) return;
      seen.add(pr.id);
      stack.push({ pr, depth });
      for (const child of (children.get(pr.id) ?? []).sort((a, b) => a.created - b.created)) walk(child, depth + 1);
    };
    walk(root, 0);
    return stack;
  };
  const stacks = roots.map(stackFrom);
  for (const pr of prs) if (!seen.has(pr.id)) stacks.push(stackFrom(pr));

  const rank = {
    newest: (stack) => -stack[0].pr.created,
    oldest: (stack) => stack[0].pr.created,
    updated: (stack) => -Math.max(...stack.map((entry) => entry.pr.updated)),
  }[sort];
  stacks.sort((a, b) => rank(a) - rank(b));

  const rows = [];
  for (const stack of stacks) {
    const shown = [];
    for (const { pr, depth } of stack) {
      shown[depth] = match(pr);
      if (!shown[depth]) continue;
      rows.push({ pr, depth: shown.slice(0, depth).filter(Boolean).length, stack: depth === 0 && stack.length > 1 ? stack.length : 0 });
    }
  }
  return rows;
}
