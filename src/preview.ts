import { DynamicBorder, getSelectListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, SelectList, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { terminalSafe } from "./capture.ts";
import { exclusionKey, normalizedBranch, type Branch } from "./startup.ts";
import type { Exclusion } from "./preferences.ts";

type State = "on" | "off" | "mixed";
type Row = { node: Branch; depth: number; inherited: boolean; state: State };

function title(node: Branch): string {
  const quoted = /^(text|heading|file|tool|message): (".*")$/.exec(node.label);
  if (quoted) {
    const text: string = JSON.parse(quoted[2]);
    return terminalSafe(quoted[1] === "tool" ? `Tool · ${text}` : quoted[1] === "message" ? `Message · ${text}` : text);
  }
  return terminalSafe(node.label === "system:" ? "System instructions" : node.label === "code: |" ? "Code block" : node.label.replace(/:$/, ""));
}

export async function preview(ctx: ExtensionCommandContext, roots: Branch[], disabled: Exclusion[], expanded: Set<string>, save: () => void, captured = false) {
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let selected: string | undefined = roots[0]?.id;
    let list: SelectList;
    let rows: Row[] = [];
    let height = 10;
    let detail: Row | undefined;
    let normalized = false;
    const parents = new Map<string, Branch>();
    const index = (nodes: Branch[], parent?: Branch) => {
      for (const node of nodes) {
        if (parent) parents.set(node.id, parent);
        index(node.children, node);
      }
    };
    index(roots);
    const container = new Container();
    const content = new Text("", 1, 0);
    const scroll = new ScrollView(content, { overscroll: "contain" });
    const border = new DynamicBorder();
    const key = (action: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(action).join("/");
    const current = () => rows.find(({ node }) => node.id === selected);
    const status = (row: Row) => row.inherited ? "Off — disabled by parent; enable the parent first."
      : row.state === "mixed" ? "Mixed — some descendants are disabled."
      : row.state === "off" ? "Off — this branch is excluded." : "On — this branch is included.";
    const openReader = () => {
      detail = current();
      if (!detail) return;
      normalized = false;
      updateContent();
    };
    const updateContent = () => {
      if (!detail) return;
      const text = normalized ? normalizedBranch(detail.node) : detail.node.raw;
      content.setText(text.split("\n").map(terminalSafe).join("\n"));
      scroll.scrollToStart();
    };
    const rebuild = () => {
      const off = new Set(disabled.map(exclusionKey));
      const states = new Map<string, State>();
      const state = (node: Branch): State => {
        const children = node.children.map(state);
        const value = off.has(exclusionKey(node.exclusion)) ? "off" : children.some((value) => value !== "on") ? "mixed" : "on";
        states.set(node.id, value);
        return value;
      };
      roots.forEach(state);
      rows = [];
      function add(nodes: Branch[], depth: number, inherited: boolean) {
        for (const node of nodes) {
          const value = inherited ? "off" : states.get(node.id)!;
          rows.push({ node, depth, inherited, state: value });
          if (expanded.has(node.id)) add(node.children, depth + 1, inherited || value === "off");
        }
      }
      add(roots, 0, false);
      list = new SelectList(rows.map(({ node, depth, state }) => ({
        value: node.id,
        label: `[${state}]`.padEnd(8) + `${"  ".repeat(Math.min(depth, 6))}${node.children.length ? expanded.has(node.id) ? "▾ " : "▸ " : "  "}${title(node)}`,
      })), height, getSelectListTheme(), { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth) });
      list.setSelectedIndex(Math.max(0, rows.findIndex(({ node }) => node.id === selected)));
      selected = list.getSelectedItem()?.value;
      list.onSelectionChange = (item) => { selected = item.value; };
      list.onCancel = () => done();
      list.onSelect = () => current()?.node.children.length ? toggleExpansion() : openReader();
    };
    const toggleExpansion = () => {
      const row = current();
      if (!row?.node.children.length) return;
      if (expanded.has(row.node.id)) expanded.delete(row.node.id); else expanded.add(row.node.id);
      save(); rebuild();
    };
    rebuild();
    return {
      capturesViewportInput: true,
      render(width: number) {
        const heading = new Text(theme.fg("accent", `Startup context · ${captured ? "Captured snapshot" : "Provisional"}`), 1, 0);
        if (detail) {
          const path = [title(detail.node)];
          for (let parent = parents.get(detail.node.id); parent; parent = parents.get(parent.id)) path.unshift(title(parent));
          const header = [
            ...border.render(width),
            ...heading.render(width),
            ...new Text(theme.fg("muted", path.join(" › ")), 1, 0).render(width).slice(-2),
            ...new Text(theme.fg("muted", `Source: ${terminalSafe(detail.node.source)}`), 1, 0).render(width).slice(0, 2),
            ...new Text(theme.fg("accent", normalized ? "Original text  ·  [Normalized YAML]" : "[Original text]  ·  Normalized YAML"), 1, 0).render(width),
            "",
          ];
          const hints = new Text(theme.fg("dim", `${key("tui.select.up")}/${key("tui.select.down")} scroll · ${key("tui.select.pageUp")}/${key("tui.select.pageDown")} page\n${key("tui.input.tab")} view · ${key("tui.select.cancel")} back`), 1, 0).render(width);
          const lines = scroll.render(width);
          // Native constrained layouts are fullscreen-only. Share ScrollView's
          // clamping/navigation in both modes, slicing its document for regular mode too.
          const viewport = Math.max(1, tui.terminal.rows - header.length - hints.length - 8);
          scroll.updateLayout(lines.length, viewport, () => tui.requestRender());
          const start = scroll.scrollTop;
          const info = ` ${start + 1}–${Math.min(start + viewport, lines.length)}/${lines.length} · Read-only; exclusions not applied`;
          return [...header, ...lines.slice(start, start + viewport), "",
            truncateToWidth(theme.fg("muted", info), width), ...hints, ...border.render(width)];
        }
        const row = current();
        const note = row ? status(row) : "No startup context available.";
        const footer = new Text(theme.fg("dim", `${key("tui.select.confirm")} expand/read · ←/→ fold/open · v read\nSpace ${row?.state === "off" && !row.inherited ? "restore" : "disable"} branch · ${key("tui.select.cancel")} back`), 1, 0);
        const statusText = new Text(theme.fg("muted", `${note} Changes affect future requests only.`), 1, 0);
        const nextHeight = Math.max(1, Math.min(Math.floor(tui.terminal.rows / 2),
          tui.terminal.rows - heading.render(width).length - footer.render(width).length - statusText.render(width).length - 8));
        if (height !== nextHeight) { height = nextHeight; rebuild(); }
        container.clear();
        container.addChild(border);
        container.addChild(heading);
        container.addChild(new Text(captured ? "" : theme.fg("muted", "May change before the first request."), 1, 0));
        container.addChild(list);
        container.addChild(statusText);
        container.addChild(footer);
        container.addChild(border);
        return container.render(width);
      },
      invalidate() { container.invalidate(); content.invalidate(); },
      handleMouse(event) {
        if (!detail) return container.handleMouse(event);
        if (event.type === "wheel" && event.wheelDelta) {
          scroll.scrollBy(event.wheelDelta);
          return { handled: true, render: true };
        }
        return undefined;
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) {
          if (detail) detail = undefined; else done();
        } else if (detail) {
          if (keys.matches(data, "tui.input.tab")) { normalized = !normalized; updateContent(); }
          else if (keys.matches(data, "tui.select.up")) scroll.scrollBy(-1);
          else if (keys.matches(data, "tui.select.down")) scroll.scrollBy(1);
          else if (keys.matches(data, "tui.select.pageUp")) scroll.scrollBy(-scroll.viewportHeight);
          else if (keys.matches(data, "tui.select.pageDown")) scroll.scrollBy(scroll.viewportHeight);
          else if (matchesKey(data, "home")) scroll.scrollToStart();
          else if (matchesKey(data, "end")) scroll.scrollToEnd();
        } else if (matchesKey(data, "space")) {
          const row = current();
          if (row && !row.inherited) {
            const at = disabled.findIndex((item) => exclusionKey(item) === exclusionKey(row.node.exclusion));
            if (at >= 0) disabled.splice(at, 1); else disabled.push(row.node.exclusion);
            save(); rebuild();
          }
        } else if (matchesKey(data, "v")) openReader();
        else if (matchesKey(data, "left") || keys.matches(data, "app.tree.foldOrUp")) {
          const row = current();
          if (row && expanded.has(row.node.id)) toggleExpansion();
          else if (row) { selected = parents.get(row.node.id)?.id ?? selected; rebuild(); }
        } else if (matchesKey(data, "right") || keys.matches(data, "app.tree.unfoldOrDown")) {
          const row = current();
          if (row?.node.children.length) {
            if (!expanded.has(row.node.id)) toggleExpansion();
            else { selected = row.node.children[0].id; rebuild(); }
          } else openReader();
        } else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
