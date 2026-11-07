import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { preview } from "../src/preview.ts";
import { branches, flatten } from "../src/startup.ts";

initTheme("dark");

test("preview exposes mixed/inherited states and reads full branches without changing exclusions", async () => {
  const roots = branches([{ role: "system", content: `<project_instructions path="/example/AGENTS.md">\n# Rules\n- keep\n- omit\n${Array.from({ length: 45 }, (_, i) => `- Instruction ${i}`).join("\n")}\n</project_instructions>\n` }]);
  const nodes = flatten(roots);
  const omit = nodes.find((node) => node.raw === "- omit\n")!;
  const disabled = [omit.exclusion];
  const expanded = new Set<string>();
  let saves = 0;
  let closed = false;
  let menu!: Component;
  const terminal = { rows: 40 };
  const ctx = { ui: { custom: async (factory: any) => {
    menu = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text }, getKeybindings(), () => { closed = true; });
  } } } as unknown as ExtensionCommandContext;
  await preview(ctx, roots, disabled, expanded, () => { saves++; });
  const render = (width = 100) => {
    const lines = menu.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.length <= terminal.rows - 2, `fits terminal: ${lines.length}/${terminal.rows}`);
    return stripVTControlCharacters(lines.join("\n"));
  };
  const key = (data: string) => { menu.handleInput!(data); return render(); };
  assert.match(render(), /Provisional/);
  assert.match(render(), /\[mixed\].*System instructions/);
  assert.match(render(), /some descendants are disabled/);
  key("\x1b[32u"); // Encoded Space disables the parent.
  assert.match(render(), /\[off\].*System instructions/);
  key("\x1b[C"); // Expand.
  key("\x1b[B"); // Select inherited child.
  assert.match(render(), /disabled by parent/);
  key(" ");
  assert.equal(disabled.length, 2, "inherited exclusions cannot be toggled independently");
  key("\x1b[D"); // Left returns to the parent, not a no-op.
  key(" ");
  assert.equal(disabled.length, 1);
  assert.match(render(), /\[mixed\]/);
  key("\x1b[D"); // Collapse while retaining mixed state.
  assert.doesNotMatch(render(), /AGENTS\.md/);
  const before = structuredClone(disabled);
  const saved = saves;
  key("\x1b[118u"); // Encoded v opens a reader, not selectable YAML lines.
  assert.match(render(), /\[Original text\]/);
  assert.match(render(), /Source: prompt/);
  assert.match(render(), /# Rules/);
  assert.match(render(), /exclusions not applied/);
  assert.doesNotMatch(render(), /^→ /m);
  assert.ok(render().includes("Instruction 15"), "reader uses more than twelve content lines");
  key("\x1b[6~"); // Page down.
  assert.doesNotMatch(render(), /# Rules/);
  key("\x1b[F"); // End.
  assert.match(render(), /Instruction 44/);
  assert.equal(key("\x1b[B"), render(), "scroll at end does not wrap to start");
  terminal.rows = 24;
  render(48);
  render(24);
  terminal.rows = 40;
  key("\t");
  assert.match(render(), /\[Normalized YAML\]/);
  assert.match(render(), /sections:/);
  key("\x1b[H"); // Home.
  key("\x1b");
  assert.match(render(), /→ \[mixed\].*System instructions/);
  assert.deepEqual(disabled, before, "reading does not change filters");
  assert.equal(saves, saved, "reading does not persist spurious changes");
  key("\x1b");
  assert.equal(closed, true);

  await preview(ctx, roots, disabled, expanded, () => {}, true);
  assert.match(render(), /Captured snapshot/);
  assert.doesNotMatch(render(), /May change before/);
});
