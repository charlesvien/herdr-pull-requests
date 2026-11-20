import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, theme, settings, run, props, shared, setShared, notify, knownAgents, checking, nextCommand } from "herdr";
import { fetchPrs, commentOnAll, arrange, attention, needsReview, ready, fixable } from "./github.js";
import { Checkouts, spaceFolder } from "./checkout.js";

const FILTERS = [
  { id: "all", label: "All", test: () => true, empty: "No open pull requests" },
  { id: "attention", label: "Needs attention", icon: "circle-alert", tone: "bad", test: attention, empty: "Nothing needs attention" },
  { id: "review", label: "Needs review", icon: "eye", tone: "warn", test: needsReview, empty: "Nothing is waiting for review" },
  { id: "ready", label: "Ready to merge", icon: "circle-check", tone: "ok", test: ready, empty: "Nothing is ready to merge yet" },
];
const SORTS = { newest: "Newest", oldest: "Oldest", updated: "Updated" };
const FIX_TASK = (url) => `Get this pull request mergeable: ${url} Its branch is checked out here. Read the unresolved review threads, the failing CI checks and any conflicts with the base branch, then fix them. Stop before committing or pushing and tell me what you changed. Don't post anything on GitHub.`;
const BOT_OWNER = "PostHog";
const BULK_ACTIONS = [
  { id: "stamp", label: "Stamp", comment: "@PostHog stamp" },
  { id: "review", label: "Review", comment: "@PostHog review" },
  { id: "deep", label: "Deep review", comment: "@PostHog review --deep" },
];
const STALE_DAYS = 60;
const ATTENTION_KEY = "pull-requests.attention";
const OPEN_KEY = "apps.open";
const BAR = 56;
const ACTIONS = 178;

const icon = (name) => svg(`mods/pull-requests/${name}.svg`).flex_none();
const alpha = (color, hex) => (color?.length === 7 ? color + hex : color);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const after = (list, current) => list[(list.indexOf(current) + 1) % list.length];
const isStale = (pr) => Date.now() - pr.updated > STALE_DAYS * 86400000;
const hasBot = (pr) => pr.repo.startsWith(`${BOT_OWNER}/`);
const selectableIds = (rows) => rows.filter((row) => hasBot(row.pr)).map((row) => row.pr.id);

function ago(time) {
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / 86400 / 30)}mo ago`;
  return `${Math.floor(seconds / 86400 / 365)}y ago`;
}

function stored(key, fallback, allowed) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export default class PullRequests extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.app = Boolean(props()?.app);
    this.focusedFor = null;
    this.filter = stored("filter", "all", FILTERS.map((filter) => filter.id));
    this.sort = stored("sort", "newest", Object.keys(SORTS));
    this.showStale = stored("stale", "hide", ["hide", "show"]) === "show";
    this.query = "";
    this.prs = null;
    this.error = null;
    this.loading = false;
    this.tried = 0;
    this.busy = {};
    this.copied = null;
    this.selected = new Set();
    this.anchor = null;
    this.armed = null;
    this.posting = null;
    this.rows = [];
    this.width = 1200;
    this.checkouts = new Checkouts();
    this.input = InputState.new({ placeholder: "Search title, repo, #number or branch" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
    cx.timer.every(30000, (cx) => {
      if (this.due()) this.refresh(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(await nextCommand(), cx);
        cx.notify();
      }
    });
    if (!checking()) this.refresh(cx);
  }

  visible() {
    if (this.app) return shared(OPEN_KEY)?.mod === "pull-requests";
    const tabs = panes().filter((pane) => pane.mod === "pull-requests").map((pane) => pane.tab);
    if (!tabs.length) return true;
    return tabs.includes(spaces().find((space) => space.active)?.tabs.find((tab) => tab.active)?.id);
  }

  due() {
    if (checking() || this.loading) return false;
    const age = Date.now() - this.tried;
    if (!this.visible()) return age >= 300000;
    return age >= ((this.prs ?? []).some((pr) => pr.checks.state === "running") ? 60000 : 180000);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.tried = Date.now();
    cx.spawn(async (cx) => {
      try {
        this.prs = await fetchPrs();
        this.error = null;
        const open = new Set(this.prs.map((pr) => pr.id));
        this.selected = new Set([...this.selected].filter((id) => open.has(id)));
        setShared(ATTENTION_KEY, { count: this.prs.filter((pr) => !isStale(pr) && attention(pr)).length, at: Date.now() });
      } catch (error) {
        this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  setFilter(filter, cx) {
    this.filter = filter;
    store("filter", filter);
    cx.notify();
  }

  setSort(sort, cx) {
    this.sort = sort;
    store("sort", sort);
    cx.notify();
  }

  setStale(show, cx) {
    this.showStale = show;
    store("stale", show ? "show" : "hide");
    cx.notify();
  }

  command(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "filter") this.setFilter(after(FILTERS.map((filter) => filter.id), this.filter), cx);
    else if (name === "sort") this.setSort(after(Object.keys(SORTS), this.sort), cx);
    else if (name === "select") this.toggleAll(this.rows, cx);
  }

  select(ids, on, cx) {
    for (const id of ids) {
      if (on) this.selected.add(id);
      else this.selected.delete(id);
    }
    this.armed = null;
    cx.notify();
  }

  toggle(pr, rows, shift, cx) {
    const ids = selectableIds(rows);
    const from = ids.indexOf(this.anchor);
    const to = ids.indexOf(pr.id);
    const range = shift && from >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : null;
    this.anchor = pr.id;
    this.select(range ?? [pr.id], Boolean(range) || !this.selected.has(pr.id), cx);
  }

  toggleAll(rows, cx) {
    const ids = selectableIds(rows);
    this.select(ids, !ids.every((id) => this.selected.has(id)), cx);
  }

  toggleStack(rows, index, cx) {
    let end = index + 1;
    while (end < rows.length && rows[end].depth > 0) end++;
    const ids = selectableIds(rows.slice(index, end));
    this.select(ids, !ids.every((id) => this.selected.has(id)), cx);
  }

  runBulk(action, targets, cx) {
    if (this.posting || !targets.length) return;
    if (this.armed?.id !== action.id) {
      const armed = { id: action.id };
      this.armed = armed;
      cx.notify();
      cx.timer.after(5000, (cx) => {
        if (this.armed !== armed) return;
        this.armed = null;
        cx.notify();
      });
      return;
    }
    this.armed = null;
    this.posting = { id: action.id, done: 0, total: targets.length };
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = await commentOnAll(targets, action.comment, (done) => {
        this.posting.done = done;
        cx.notify();
      });
      this.selected = new Set(failed.map((entry) => entry.pr.id));
      this.posting = null;
      if (failed.length) notify({ title: `Couldn't comment on ${failed.length} of ${plural(targets.length, "PR")}`, body: failed[0].error, level: "error" });
      else notify({ title: `Posted "${action.comment}" on ${plural(targets.length, "PR")}`, level: "success" });
      cx.notify();
    });
  }

  checkbox(id, state, t, action) {
    return div().id(id).w(30).h(30).flex().flex_none().items_center().cursor_pointer()
      .when(Boolean(action), (el) => el.on_click(action))
      .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border_1()
        .border_color(state === "off" ? t.dim : t.accent)
        .when(state !== "off", (el) => el.bg(t.accent))
        .when(state === "on", (el) => el.child(icon("check").size(12).text_color(t.accent_foreground)))
        .when(state === "some", (el) => el.child(div().w(8).h(2).rounded(1).bg(t.accent_foreground))));
  }

  async agentArgv() {
    if (!this.argv) {
      const known = await knownAgents().catch(() => []);
      this.argv = known.find((agent) => agent.installed)?.run ?? ["claude"];
    }
    return this.argv;
  }

  open(pr, cx, fix) {
    if (this.busy[pr.id]) return;
    this.busy[pr.id] = fix ? "agent" : "space";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { path, space, created } = await this.checkouts.prepare(pr);
        if (created) notify({ title: `Created a worktree for ${pr.head}`, body: path });
        if (!fix) {
          if (space) run("space.select", { id: space.id });
          else run("space.new", { folder: path });
          return;
        }
        const launch = { folder: path, argv: await this.agentArgv(), task: FIX_TASK(pr.url) };
        const name = `Fix #${pr.number}`;
        if (space) run("tab.new", { ...launch, space: space.id, name });
        else run("space.new", { ...launch, tab: name });
      } catch (error) {
        notify({ title: `Couldn't open ${pr.repo}#${pr.number}`, body: String(error?.message ?? error), level: "error" });
      } finally {
        delete this.busy[pr.id];
        cx.notify();
      }
    });
  }

  copy(pr, cx) {
    cx.write_to_clipboard(pr.url);
    this.copied = pr.id;
    cx.notify();
    cx.timer.after(1400, (cx) => {
      if (this.copied !== pr.id) return;
      this.copied = null;
      cx.notify();
    });
  }

  liveSpace(pr, paneList) {
    const name = pr.repo.split("/")[1];
    return spaces().find((space) => !space.machine && space.branch === pr.head && `${spaceFolder(space, paneList) ?? ""}/`.includes(`/${name}/`));
  }

  pill(color) {
    return h_flex().h(24).flex_none().items_center().rounded(6).border_1().border_color(alpha(color, "59")).bg(alpha(color, "1f")).text_color(color).text_size(12).font_medium();
  }

  reviewBadge(pr, t, c) {
    const [name, color, tip] = {
      approved: ["circle-check", c.ok, "Approved"],
      changes: ["circle-alert", c.bad, "Changes requested"],
      required: ["eye", c.warn, "Waiting for review"],
      none: ["eye", t.dim, "No review required"],
    }[pr.review];
    return this.pill(color).id(`review-${pr.id}`).w(30).justify_center().tooltip(tip).child(icon(name).size(14));
  }

  checksPill(pr, t, c, bar) {
    const checks = pr.checks;
    const running = checks.state === "running" && !pr.conflicts;
    const [name, color, label] = pr.conflicts
      ? ["circle-alert", c.bad, "Conflicts"]
      : checks.state === "failing"
        ? ["circle-x", c.bad, checks.failed ? `${checks.failed} failing` : "Failing"]
        : running
          ? ["spinner", c.run, `${checks.passed}/${checks.total} running`]
          : checks.state === "passing"
            ? ["circle-check", c.ok, "Ready"]
            : ["circle-dashed", t.dim, "No checks"];
    const share = (count) => Math.round((BAR * count) / checks.total);
    return this.pill(color).px(8).gap(7)
      .child(running ? icon(name).size(13).spin(900) : icon(name).size(14))
      .child(label)
      .when(bar && checks.total > 0, (el) =>
        el.child(h_flex().w(BAR).h(5).flex_none().rounded(3).overflow_hidden().bg(alpha(color, "40"))
          .child(div().h_full().w(share(checks.passed)).bg(c.ok))
          .child(div().h_full().w(share(checks.failed)).bg(c.bad))));
  }

  actions(pr, t, live) {
    const enabled = fixable(pr);
    const busy = this.busy[pr.id];
    const spinner = () => icon("spinner").size(14).spin(900);
    const button = (id, glyph, tip, color, action) =>
      div().id(`${id}-${pr.id}`).size(28).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(color).hover((s) => s.bg(t.selected).text_color(t.foreground)).tooltip(tip)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          action(cx);
        })
        .child(glyph);
    const liveColor = live ? ({ working: t.working, blocked: t.blocked, done: t.done }[live.status] ?? t.accent) : t.muted;
    const terminalGlyph = busy === "space" || live?.status === "working" ? spinner() : icon("terminal").size(15);
    return h_flex().id(`actions-${pr.id}`).flex_none().w(ACTIONS).justify_end().gap(2).items_center().cursor_default()
      .on_click((_e, cx) => cx.stop_propagation())
      .child(h_flex().id(`fix-${pr.id}`).h(28).px(8).mr(4).gap(6).flex_none().items_center().rounded(6).font_medium()
        .text_color(enabled ? t.foreground : t.dim)
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
        .tooltip(enabled ? "Start an agent that gets this PR mergeable" : "Nothing to fix")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (enabled) this.open(pr, cx, true);
        })
        .child(busy === "agent" ? spinner() : icon("bot").size(15))
        .child("Fix"))
      .child(button("space", terminalGlyph, live ? `Go to ${live.name}` : "Open this branch in a space", liveColor, (cx) => this.open(pr, cx, false)))
      .child(button("copy", icon(this.copied === pr.id ? "check" : "copy").size(15), "Copy link", this.copied === pr.id ? t.accent : t.muted, (cx) => this.copy(pr, cx)))
      .child(button("github", icon("external").size(15), "Open on GitHub", t.muted, (cx) => cx.open_url(pr.url)));
  }

  row({ pr, depth, stack }, index, rows, t, c, cols, paneList) {
    const selectable = hasBot(pr);
    const on = selectable && this.selected.has(pr.id);
    return h_flex().id(`pr-${pr.id}`).h(60).flex_none().px(16).items_center().border_b(1).border_color(t.border)
      .when(on, (el) => el.bg(alpha(t.accent, "14")))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(selectable, (el) => el.cursor_pointer().on_click((e, cx) => this.toggle(pr, rows, e.modifiers.shift, cx)))
      .when(cols.select, (el) => el.child(selectable ? this.checkbox(`select-${pr.id}`, on ? "on" : "off", t) : div().w(30).flex_none()))
      .child(v_flex().flex_1().min_w(0).pl(depth * 22).pr(16).gap(4)
        .child(div().truncate().text_size(13.5).font_medium().child(pr.title))
        .child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
          .when(stack > 0, (el) =>
            el.child(h_flex().id(`stack-${pr.id}`).h(18).flex_none().px(6).gap(5).items_center().rounded(4).bg(alpha(c.stack, "38")).text_color(c.stack).text_size(10.5).font_semibold()
              .when(selectable, (badge) => badge.cursor_pointer().hover((s) => s.bg(alpha(c.stack, "59"))).tooltip("Select the whole stack")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.toggleStack(rows, index, cx);
                }))
              .child(icon("layers").size(11)).child(`STACK OF ${stack}`)))
          .when(pr.draft, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.raised).text_size(10.5).font_semibold().child("DRAFT")))
          .child(div().min_w(0).truncate().child(`${pr.repo}#${pr.number} · @${pr.author} · opened ${ago(pr.created)}`))))
      .child(h_flex().w(cols.status).flex_none().gap(6).items_center()
        .child(this.reviewBadge(pr, t, c))
        .child(this.checksPill(pr, t, c, cols.bar))
        .when(pr.threads > 0, (el) =>
          el.child(this.pill(c.warn).id(`threads-${pr.id}`).px(7).gap(5).tooltip(plural(pr.threads, "unresolved review thread"))
            .child(icon("message").size(13)).child(String(pr.threads)))))
      .when(cols.updated > 0, (el) => el.child(div().w(cols.updated).flex_none().text_color(t.muted).child(ago(pr.updated))))
      .child(this.actions(pr, t, this.liveSpace(pr, paneList)));
  }

  render(cx) {
    const t = theme();
    if (this.due()) this.refresh(cx);
    const opened = this.app ? (shared(OPEN_KEY)?.place ?? null) : null;
    if (opened !== this.focusedFor) {
      this.focusedFor = opened;
      if (opened) this.handle.focus();
    }

    const c = { ok: t.ansi2, run: t.ansi4, warn: t.ansi3, bad: t.ansi1, stack: t.ansi5 };
    const all = this.prs ?? [];
    const stale = all.filter(isStale).length;
    const scoped = this.showStale ? all : all.filter((pr) => !isStale(pr));
    const needle = this.query.trim().toLowerCase();
    const filter = FILTERS.find((candidate) => candidate.id === this.filter) ?? FILTERS[0];
    const rows = arrange(needle ? all : scoped, this.sort, (pr) => filter.test(pr) && (!needle || `${pr.title} ${pr.repo}#${pr.number} @${pr.author} ${pr.head}`.toLowerCase().includes(needle)));
    this.rows = rows;
    const selectable = selectableIds(rows);
    const chosen = rows.filter((row) => hasBot(row.pr) && this.selected.has(row.pr.id)).map((row) => row.pr);
    const compact = this.width < 940;
    const cols = { select: selectable.length > 0, bar: this.width >= 1040, status: this.width >= 1040 ? 310 : 246, updated: this.width >= 820 ? 84 : 0 };
    const paneList = panes();
    const empty = needle ? `Nothing matches "${this.query.trim()}"` : this.prs ? filter.empty : this.loading ? "Loading pull requests…" : "";

    const toolbar = h_flex().h(52).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_none().p(3).gap(2).rounded(9).bg(t.raised).children(FILTERS.map((option) => {
        const on = option.id === filter.id;
        const count = scoped.filter(option.test).length;
        const labelled = !compact || !option.icon;
        return h_flex().id(`filter-${option.id}`).h(26).px(10).gap(7).items_center().rounded(6).cursor_pointer().font_medium()
          .text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
          .when(!labelled, (el) => el.tooltip(option.label))
          .on_click((_e, cx) => this.setFilter(option.id, cx))
          .when(Boolean(option.icon), (el) => el.child(icon(option.icon).size(14).text_color(count > 0 ? c[option.tone] : t.dim)))
          .when(labelled, (el) => el.child(option.label))
          .child(div().text_color(t.dim).child(String(count)));
      })))
      .child(div().flex_1())
      .child(h_flex().id("search").h(30).w(this.width >= 1100 ? 280 : 190).flex_shrink(1).min_w(120).px(9).gap(7).items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(icon("search").size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().id("refresh").size(28).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
        .on_click((_e, cx) => {
          this.refresh(cx);
          cx.notify();
        })
        .child(this.loading ? icon("spinner").size(14).spin(900) : icon("refresh").size(15)));

    const labels = h_flex().flex_1().min_w(0).items_center().text_size(10.5).font_semibold().text_color(t.dim)
      .child(div().flex_1().child("TITLE"))
      .child(div().w(cols.status).flex_none().child("STATUS"))
      .when(cols.updated > 0, (el) => el.child(div().w(cols.updated).flex_none().child("UPDATED")))
      .child(h_flex().w(ACTIONS).flex_none().justify_end()
        .child(h_flex().id("sort").h(22).px(6).gap(5).items_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Change the order")
          .on_click((_e, cx) => this.setSort(after(Object.keys(SORTS), this.sort), cx))
          .child(icon("sort").size(12))
          .child(SORTS[this.sort].toUpperCase())));

    const bulk = h_flex().flex_1().min_w(0).gap(8).items_center().text_size(12)
      .child(div().flex_none().mr(4).font_medium().child(`${chosen.length} selected`))
      .children(BULK_ACTIONS.map((action) => {
        const armed = this.armed?.id === action.id;
        const running = this.posting?.id === action.id;
        const enabled = !this.posting;
        return h_flex().id(`bulk-${action.id}`).h(24).px(9).gap(6).flex_none().items_center().rounded(6).border_1().font_medium()
          .border_color(armed ? t.solid : t.input)
          .text_color(armed ? t.solid_foreground : enabled || running ? t.foreground : t.dim)
          .when(armed, (el) => el.bg(t.solid))
          .when(enabled, (el) => el.cursor_pointer())
          .when(enabled && !armed, (el) => el.hover((s) => s.bg(t.hover)))
          .tooltip(`Comments "${action.comment}" on each selected PR`)
          .on_click((_e, cx) => this.runBulk(action, chosen, cx))
          .when(running, (el) => el.child(icon("spinner").size(12).spin(900)))
          .child(running ? `Posting ${this.posting.done}/${this.posting.total}` : armed ? `Post on ${plural(chosen.length, "PR")}?` : action.label);
      }))
      .child(div().flex_1())
      .child(div().id("clear-selection").px(7).h(22).flex().flex_none().items_center().rounded(5).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.select([...this.selected], false, cx))
        .child("Clear"));

    const columns = h_flex().h(36).flex_none().px(16).items_center().border_b(1).border_color(t.border)
      .when(cols.select, (el) => el.child(this.checkbox("select-all", !chosen.length ? "off" : chosen.length === selectable.length ? "on" : "some", t, (_e, cx) => this.toggleAll(rows, cx))))
      .child(chosen.length ? bulk : labels);

    const staleNote = h_flex().h(44).flex_none().px(16).gap(10).items_center().text_size(12).text_color(t.dim)
      .child(this.showStale ? `Showing ${plural(stale, "pull request")} with no activity in ${STALE_DAYS} days` : `${plural(stale, "pull request")} with no activity in ${STALE_DAYS} days ${stale === 1 ? "is" : "are"} hidden`)
      .child(div().id("stale").px(6).h(22).flex().items_center().rounded(5).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.setStale(!this.showStale, cx))
        .child(this.showStale ? "Hide" : "Show"));

    return v_flex().id("pull-requests").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .when(this.app, (el) => el.rounded(10).overflow_hidden().border_1().border_color(t.border))
      .on_size_change((size, cx) => {
        const width = size.width / (settings().zoom ?? 1);
        if (width === this.width) return;
        this.width = width;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.typing) this.handle.focus();
        else if (this.app) run("apps.close");
        else return;
        cx.stop_propagation();
      })
      .child(toolbar)
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).py(8).border_b(1).border_color(t.border).text_size(12).text_color(c.bad).child(this.error ?? "")))
      .child(columns)
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("pr-list").absolute().inset_0().overflow_y_scroll()
          .children(rows.map((row, index) => this.row(row, index, rows, t, c, cols, paneList)))
          .when(!rows.length && Boolean(empty), (el) => el.child(div().flex_none().px(16).py(18).text_color(t.dim).child(empty)))
          .when(stale > 0 && !needle, (el) => el.child(staleNote)))
        .child(Scrollbar.vertical("pr-list").absolute().inset_0()));
  }
}
