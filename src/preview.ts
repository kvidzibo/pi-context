import { DynamicBorder, getSelectListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { terminalSafe } from "./capture.ts";
import { exclusionKey, normalizedBranch, type Branch } from "./startup.ts";
import type { Exclusion } from "./preferences.ts";

export async function preview(ctx: ExtensionCommandContext, roots: Branch[], disabled: Exclusion[], expanded: Set<string>, save: () => void) {
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let selected = roots[0]?.id;
    let list: SelectList;
    let rows: { node: Branch; depth: number; inherited: boolean }[] = [];
    let height = 10;
    const container = new Container();
    const rebuild = () => {
      const off = new Set(disabled.map(exclusionKey));
      rows = [];
      function add(nodes: Branch[], depth: number, inherited: boolean) {
        for (const node of nodes) {
          rows.push({ node, depth, inherited });
          if (expanded.has(node.id)) add(node.children, depth + 1, inherited || off.has(exclusionKey(node.exclusion)));
        }
      }
      add(roots, 0, false);
      list = new SelectList(rows.map(({ node, depth, inherited }) => ({
        value: node.id,
        label: `${inherited || off.has(exclusionKey(node.exclusion)) ? "[off]" : "[on] "} ${"  ".repeat(Math.min(depth, 8))}${node.children.length ? expanded.has(node.id) ? "▾ " : "▸ " : "  "}${terminalSafe(node.label)}`,
      })), height, getSelectListTheme());
      list.setSelectedIndex(Math.max(0, rows.findIndex(({ node }) => node.id === selected)));
      list.onSelectionChange = (item) => { selected = item.value; };
      list.onCancel = () => done();
      list.onSelect = () => expand();
      container.clear();
      container.addChild(new DynamicBorder());
      container.addChild(new Text(theme.fg("accent", "Startup context · normalized reading view"), 0, 0));
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", `${keys.getKeys("tui.select.confirm").join("/")} expand/minimise · Space enable/disable · v full branch`), 0, 0));
      container.addChild(new Text(theme.fg("dim", "Esc back · Changes apply to subsequent requests, not history."), 0, 0));
      container.addChild(new DynamicBorder());
    };
    const current = () => rows.find(({ node }) => node.id === selected) ?? rows[0];
    const expand = () => {
      const row = current();
      if (!row?.node.children.length) return;
      if (expanded.has(row.node.id)) expanded.delete(row.node.id); else expanded.add(row.node.id);
      save(); rebuild();
    };
    let detail: SelectList | undefined;
    let detailText: string | undefined;
    let detailWidth = 0;
    rebuild();
    return {
      capturesViewportInput: true,
      render(width: number) {
        const nextHeight = Math.max(3, Math.min(12, tui.terminal.rows - 10));
        if (height !== nextHeight) { height = nextHeight; rebuild(); }
        if (detailText !== undefined) {
          if (!detail || detailWidth !== width) {
            const selectedLine = Number(detail?.getSelectedItem()?.value ?? 0);
            detailWidth = width;
            const lines = detailText.split("\n").flatMap((line) => wrapTextWithAnsi(terminalSafe(line) || " ", Math.max(1, width - 4)));
            detail = new SelectList(lines.map((label, index) => ({ value: String(index), label })), height, getSelectListTheme());
            detail.setSelectedIndex(Math.min(selectedLine, lines.length - 1));
            detail.onCancel = () => { detail = undefined; detailText = undefined; };
          }
          return [new DynamicBorder().render(width)[0], ...detail.render(width), truncateToWidth(theme.fg("dim", "Esc back"), width), new DynamicBorder().render(width)[0]];
        }
        return container.render(width);
      },
      invalidate() { container.invalidate(); detail?.invalidate(); },
      handleInput(data: string) {
        if (detail) detail.handleInput(data);
        else if (data === " ") {
          const row = current();
          if (row && !row.inherited) {
            const index = disabled.findIndex((item) => exclusionKey(item) === exclusionKey(row.node.exclusion));
            if (index >= 0) disabled.splice(index, 1); else disabled.push(row.node.exclusion);
            save(); rebuild();
          }
        } else if (data === "v") {
          const row = current();
          if (row) {
            detailText = normalizedBranch(row.node);
            detail = undefined;
          }
        } else if (matchesKey(data, "right") || matchesKey(data, "left")) {
          const row = current();
          if (row && expanded.has(row.node.id) === matchesKey(data, "left")) expand();
        } else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
