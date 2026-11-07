import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import contextInspector from "../src/index.ts";
import { parse } from "yaml";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme("dark");

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let renderer: any;
  const entries: Array<{ type: string; data: { paths: string[] } }> = [];
  const menus: string[] = [];
  const selections: Array<number | undefined> = [];
  const notices: string[] = [];
  const prefills: string[] = [];
  let folder: string | undefined;
  contextInspector({
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
    registerCommand(_name: string, spec: { handler: typeof command }) { command = spec.handler; },
    registerEntryRenderer(_type: string, value: any) { renderer = value; },
    appendEntry(type: string, data: { paths: string[] }) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui", cwd: tmpdir(), model: { provider: "test", id: "model" },
    ui: {
      async editor(_title: string, prefill: string) { prefills.push(prefill); return folder; },
      notify(message: string) { notices.push(message); },
      async custom(factory: any) {
        let closed = false;
        let result: string | undefined;
        const menu = factory({ requestRender() {} }, null, null, (value: string | undefined) => { closed = true; result = value; });
        while (!closed) {
          for (const width of [120, 48, 24]) {
            assert.ok(menu.render(width).every((line: string) => visibleWidth(line) <= width));
          }
          menus.push(stripVTControlCharacters(menu.render(160).join("\n")));
          const selection = selections.shift();
          if (selection === undefined) menu.handleInput("\x1b");
          else {
            const rows = stripVTControlCharacters(menu.render(160).join("\n")).split("\n")
              .filter((line) => /^(→ |  )(Capture|Output)/.test(line));
            const current = rows.findIndex((line) => line.startsWith("→ "));
            assert.ok(current >= 0);
            for (let i = 0; i < (selection - current + 3) % 3; i++) menu.handleInput("\x1b[B");
            menu.handleInput("\r");
          }
        }
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx, entries, menus, notices, prefills,
    choose: (...choices: Array<number | undefined>) => selections.push(...choices),
    folder: (value: string | undefined) => { folder = value; },
    emit: async (name: string, event = {}) => handlers.get(name)!(event, ctx),
    command: (args = "") => command(args, ctx),
    savedText: () => entries.map((entry) => renderer({ data: entry.data }, {}, { fg: (_color: string, text: string) => text }).render(200).join("\n")).join("\n"),
  };
}

test("native menu cycles formats, defaults to a temporary directory, and resets per session", async (t) => {
  const app = setup();
  const other = setup();
  app.choose(2);
  await app.command();
  const directory = app.prefills[0];
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(directory, new RegExp(`^${tmpdir()}/pi-context-`));
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.match(app.menus[0], /Capture\s+off/);
  assert.match(app.menus[0], /Output\s+JSON/);
  assert.ok(app.menus[0].includes(directory));
  assert.doesNotMatch(app.menus[0], /Readable|Save raw/);
  await app.emit("before_provider_request", { payload: { disabled: true } });
  await assert.rejects(stat(directory), { code: "ENOENT" });

  app.choose(0);
  await app.command();
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const extension of [".json", ".yml", ".normalized.yml", ".json"]) {
    await app.emit("before_provider_request", { payload: { text: "hello" } });
    await app.emit("turn_end");
    assert.ok(app.entries.at(-1)!.data.paths[0].endsWith(extension));
    app.choose(1);
    await app.command();
  }
  await other.emit("before_provider_request", { payload: { other: true } });
  await other.emit("turn_end");
  assert.equal(other.entries.length, 0);
  for (const event of ["session_shutdown", "session_start"]) {
    await app.emit(event);
    app.choose(2);
    await app.command();
    assert.match(app.menus.at(-1)!, /Capture\s+off/);
    assert.match(app.menus.at(-1)!, /Output\s+JSON/);
    assert.notEqual(app.prefills.at(-1), directory);
    await app.emit("before_provider_request", { payload: { reset: true } });
    await app.emit("turn_end");
    assert.equal(app.entries.length, 4);
  }
  await app.command("raw");
  assert.match(app.notices.at(-1)!, /Usage: \/context/);
  app.ctx.mode = "rpc";
  await app.command();
  assert.match(app.notices.at(-1)!, /requires TUI/);
});

test("Save normalized YAML structures nested tags and JSON without changing requests or raw saving", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-normalized-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = setup();
  const code = '```json\n{"keep": "code"}\n```\n~~~xml\n<tag>example</tag>\n~~~\n    <tag>indented code</tag>\nInline `<tag>example</tag>` stays.\n';
  const payload = {
    instructions: 'Intro\n<project_context>\n<project_instructions path="/a.md">\nRules\n</project_instructions>\n<project_instructions path="/b.md">more</project_instructions>\n</project_context>\n<tag></tag>\n',
    remote: '<pinote_remote>\nUntrusted data\n' + JSON.stringify({ service: "pinote", text: 'Selected task:\n{"id":339}\nAfter\n' }) + '\n</pinote_remote>\n',
    arguments: '{"count":2,"nested":"[1,true,null]"}',
    indentedJson: '    {"keep":true}\n', adjacentTags: "<a>x</a><a>y</a>",
    code, malformed: "<a>\n</b>", brokenJson: '{"x": nope}', duplicateJson: '{"x":1,"x":2}',
    preciseJson: '{"id":9007199254740993}',
    duplicateAttributes: '<tag path="/a" path="/b">Rules</tag>',
    multilineCode: "Example: `\n<tag>example</tag>\n`",
    multilineTicks: "Example: ``\n` <tag>example</tag>\n``",
    literal: "true", stream: true,
  };
  const original = structuredClone(payload);
  app.folder(directory);
  app.choose(2, 1, 1, 0);
  await app.command();
  assert.equal(await app.emit("before_provider_request", { payload }), undefined);
  assert.deepEqual(payload, original);
  await app.emit("turn_end");
  const path = app.entries[0].data.paths[0];
  assert.match(path, /\.normalized\.yml$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const saved = await readFile(path, "utf8");
  const view = parse(saved, { intAsBigInt: true });
  assert.equal(view.format, "pi-context-normalized-v1");
  assert.match(view.note, /not the exact provider request/);
  assert.deepEqual(view.request.instructions, { sections: [
    { text: "Intro\n" },
    { tag: "project_context", content: { sections: [
      { tag: "project_instructions", attributes: { path: "/a.md" }, content: "Rules\n" },
      { tag: "project_instructions", attributes: { path: "/b.md" }, content: "more" },
    ] } },
    { tag: "tag", content: "" },
  ] });
  assert.deepEqual(view.request.remote.sections[0].content.sections, [
    { text: "Untrusted data\n" },
    { json: { service: "pinote", text: { sections: [
      { text: "Selected task:\n" }, { json: { id: 339n } }, { text: "After\n" },
    ] } } },
  ]);
  assert.deepEqual(view.request.arguments, { count: 2n, nested: [1n, true, null] });
  assert.equal(view.request.preciseJson.id, 9007199254740993n);
  for (const field of ["code", "indentedJson", "adjacentTags", "multilineCode", "multilineTicks", "duplicateAttributes", "malformed", "brokenJson", "duplicateJson", "literal", "stream"] as const) {
    assert.equal(view.request[field], payload[field]);
  }
  app.folder(undefined);
  app.choose(2, undefined); // Cancelling the directory editor keeps normalized saving.
  await app.command();
  await app.emit("before_provider_request", { payload });
  await app.emit("turn_end");
  assert.match(app.entries[1].data.paths[0], /\.normalized\.yml$/);
  app.choose(1, 1); // Normalized YAML -> JSON -> YAML.
  await app.command();
  await app.emit("before_provider_request", { payload });
  await app.emit("turn_end");
  assert.deepEqual(parse(await readFile(app.entries[2].data.paths[0], "utf8")), original);
});

test("directory editing preserves capture state, saves privately, and reports paths outside context", async () => {
  const app = setup();
  const directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
  app.ctx.cwd = directory;
  try {
    app.choose(2, undefined);
    await app.command(); // Cancelling does not start saving or create the suggestion.
    assert.match(app.prefills[0], new RegExp(`^${tmpdir()}/pi-context-`));
    assert.deepEqual(await readdir(directory), []);

    app.folder("raw requests");
    app.choose(2, 1, 0);
    await app.command();
    const folder = join(directory, "raw requests");
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    const payloads = [{ messages: [{ role: "user", content: "first" }], stream: true }, { messages: [{ role: "user", content: "follow-up" }], stream: true }];
    for (const payload of payloads) {
      const original = structuredClone(payload);
      assert.equal(await app.emit("before_provider_request", { payload }), undefined);
      assert.deepEqual(payload, original);
    }
    assert.equal(app.entries.length, 0);
    await app.emit("turn_end");
    assert.equal(app.entries.length, 1);
    assert.equal(app.entries[0].type, "context-saved");
    const paths = app.entries[0].data.paths;
    assert.equal(new Set(paths).size, 2);
    assert.equal(paths.length, 2);
    for (let i = 0; i < paths.length; i++) {
      assert.ok(isAbsolute(paths[i]));
      assert.match(paths[i], /\.yml$/);
      assert.deepEqual(parse(await readFile(paths[i], "utf8")), payloads[i]);
      assert.equal((await stat(paths[i])).mode & 0o777, 0o600);
      assert.ok(app.savedText().includes(`Context request saved: ${paths[i]}`));
    }
    await app.emit("agent_end");
    assert.equal(app.entries.length, 1, "do not report the same paths twice");
    await app.emit("before_provider_request", { payload: { next: true } });
    await app.emit("turn_end");
    assert.equal(app.entries.length, 2);
    assert.equal((await readdir(folder)).length, 3);

    app.choose(0, undefined);
    await app.command();
    await app.emit("before_provider_request", { payload: { disabled: true } });
    await app.emit("turn_end");
    assert.equal((await readdir(folder)).length, 3);
    assert.equal(app.entries.length, 2);
    app.folder(undefined);
    app.choose(2, undefined);
    await app.command();
    assert.equal(app.prefills.at(-1), folder);
    assert.match(app.menus.at(-1)!, /Capture\s+off/, "cancelling preserves capture state");

    app.folder("\n");
    app.choose(2, undefined);
    await app.command();
    assert.match(app.notices.at(-1)!, /Enter one folder path/);
    app.choose(0, undefined);
    await app.command();
    await rm(folder, { recursive: true });
    assert.equal(await app.emit("before_provider_request", { payload: { failsToSave: true } }), undefined);
    assert.match(app.notices.at(-1)!, /Could not save YAML context request/);
    await app.emit("turn_end");
    assert.equal(app.entries.length, 2, "failed writes must not claim success");

    await app.emit("session_start");
    app.choose(2, undefined);
    await app.command();
    assert.notEqual(app.prefills.at(-1), folder);
    await app.emit("before_provider_request", { payload: { newSession: true } });
    await app.emit("turn_end");
    assert.equal(app.entries.length, 2, "raw saving resets on a new session");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
