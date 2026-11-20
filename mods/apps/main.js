import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, spaces, panes, focused, shared, setShared, layout, props, window, settings, nextCommand } from "herdr";

const APPS = [{ mod: "pull-requests", view: "app-pull-requests", name: "Pull requests", icon: "mods/apps/pull-request.svg", badge: "pull-requests.attention", badgeHint: "need attention" }];
const OPEN_KEY = "apps.open";
const STACK = "views";
const WORKSPACE = "work";
const BADGE_MAX_AGE = 20 * 60000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const alpha = (color, hex) => (color?.length === 7 ? color + hex : color);
const openApp = () => APPS.find((app) => app.mod === shared(OPEN_KEY)?.mod) ?? null;

function activeTab() {
  const space = spaces().find((candidate) => candidate.active);
  return { space: space?.id ?? null, tab: space?.tabs.find((tab) => tab.active)?.id ?? null };
}

function place() {
  const { space, tab } = activeTab();
  return space ? `${space}:${tab}` : null;
}

export default class Apps extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const name = await nextCommand();
        const app = APPS.find((candidate) => candidate.mod === name);
        if (app) this.toggle(app);
        else if (name === "close") this.close();
        cx.notify();
      }
    });
  }

  toggle(app) {
    if (openApp() === app) return this.close();
    setShared(OPEN_KEY, { mod: app.mod, place: place() });
    run("layout.select", { stack: STACK, child: app.view });
  }

  close() {
    if (!openApp()) return;
    setShared(OPEN_KEY, null);
    run("layout.select", { stack: STACK, child: WORKSPACE });
    const pane = focused()?.pane ?? panes().find((candidate) => candidate.focused && candidate.tab === activeTab().tab)?.pane;
    if (pane) run("pane.focus", { pane });
  }

  reconcile() {
    const shown = find(layout(), STACK)?.active;
    if (!shown) return null;
    const app = openApp();
    const here = place();
    if (app && here && shared(OPEN_KEY).place !== here) {
      setShared(OPEN_KEY, null);
      run("layout.select", { stack: STACK, child: WORKSPACE });
      return null;
    }
    const wanted = app?.view ?? WORKSPACE;
    if (shown !== wanted) run("layout.select", { stack: STACK, child: wanted });
    return app;
  }

  bar(t, app) {
    const root = layout();
    const sidebar = find(root, "sidebar");
    const frame = window();
    const lights = frame?.platform === "macos" && frame.titlebar === "none" && !frame.fullscreen && root?.traffic_lights;
    const inset = lights ? Math.max(16, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0))) : 16;
    return h_flex().size_full().min_w(0).pl(inset).pr(10).gap(9).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(13)
      .child(svg(app.icon).size(15).flex_none().text_color(t.muted))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(app.name))
      .child(div().flex_1())
      .child(div().id("app-close").size(26).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Back to your terminals (Esc)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.close())
        .child(svg("mods/apps/x.svg").size(14)));
  }

  render() {
    const t = theme();
    const open = this.reconcile();
    const role = props()?.bar;
    if (role) {
      const app = APPS.find((candidate) => candidate.mod === role);
      return app ? this.bar(t, app) : div();
    }

    const collapsed = narrow();
    const row = (app) => {
      const on = open === app;
      const info = shared(app.badge);
      const count = info && Date.now() - info.at < BADGE_MAX_AGE ? info.count : 0;
      const glyph = svg(app.icon).size(15).flex_none().text_color(on ? t.foreground : t.muted);
      const base = h_flex().id(`app-${app.mod}`).flex_none().items_center().cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.toggle(app));
      if (collapsed) {
        return base.relative().w(32).h(26).rounded(6).justify_center().tooltip(count > 0 ? `${app.name} · ${count} ${app.badgeHint}` : app.name)
          .child(glyph)
          .when(count > 0, (el) => el.child(div().absolute().top(4).right(5).size(6).rounded_full().bg(t.ansi1)));
      }
      return base.h(30).px(8).gap(9).rounded(8)
        .child(h_flex().size(18).flex_none().items_center().justify_center().child(glyph))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(app.name))
        .when(count > 0, (el) =>
          el.child(h_flex().id(`app-badge-${app.mod}`).h(17).min_w(19).px(5).flex_none().items_center().justify_center().rounded(9).bg(alpha(t.ansi1, "2e")).text_size(11).font_medium().text_color(t.ansi1)
            .tooltip(`${count} ${app.badgeHint}`).child(String(count))));
    };

    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .when(!collapsed, (el) =>
        el.child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().child(div().text_size(11.5).font_medium().text_color(t.dim).child("Apps"))))
      .child(v_flex().px(collapsed ? 0 : 8).when(collapsed, (el) => el.pt(8).items_center()).children(APPS.map(row)));
  }
}
