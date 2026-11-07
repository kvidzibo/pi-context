import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import contextInspector from "../src/index.ts";
import { parse } from "yaml";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { branches, filterStartup, flatten } from "../src/startup.ts";
import { loadPreferences, savePreferences } from "../src/preferences.ts";
import { analyse, removalRequest } from "../src/provenance.ts";

initTheme("dark");

function setup(agentDir = join(tmpdir(), `pi-context-settings-${Math.random()}`), previous: any[] = []) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let renderer: any;
  const entries: Array<{ type: string; data: any }> = [...previous];
  const menus: string[] = [];
  const selections: Array<number | undefined> = [];
  const notices: string[] = [];
  const prefills: string[] = [];
  let folder: string | undefined;
  const previewKeys: string[] = [];
  const requests: string[] = [];
  let confirm = true;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  contextInspector({
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getActiveTools: () => [], getAllTools: () => [],
    sendUserMessage: (text: string) => requests.push(text),
    registerCommand(_name: string, spec: { handler: typeof command }) { command = spec.handler; },
    registerEntryRenderer(_type: string, value: any) { renderer = value; },
    appendEntry(type: string, data: { paths: string[] }) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI);
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  const ctx = {
    mode: "tui", cwd: tmpdir(), model: { provider: "test", id: "model" },
    isIdle: () => true,
    getSystemPrompt: () => "Startup rules\n",
    getSystemPromptOptions: () => ({ cwd: tmpdir() }),
    sessionManager: { getBranch: () => entries.map(({ type, data }) => ({ type: "custom", customType: type, data })) },
    ui: {
      async confirm() { return confirm; },
      async editor(_title: string, prefill: string) { prefills.push(prefill); return folder; },
      notify(message: string) { notices.push(message); },
      async custom(factory: any) {
        let closed = false;
        let result: string | undefined;
        const menu = factory({ requestRender() {}, terminal: { rows: 40 } }, { fg: (_color: string, text: string) => text }, getKeybindings(), (value: string | undefined) => { closed = true; result = value; });
        while (!closed) {
          for (const width of [120, 48, 24]) {
            assert.ok(menu.render(width).every((line: string) => visibleWidth(line) <= width));
          }
          menus.push(stripVTControlCharacters(menu.render(160).join("\n")));
          if (menus.at(-1)!.includes("Startup context")) {
            menu.handleInput(previewKeys.shift() ?? "\x1b");
            continue;
          }
          const selection = selections.shift();
          if (selection === undefined) menu.handleInput("\x1b");
          else {
            const rows = stripVTControlCharacters(menu.render(160).join("\n")).split("\n")
              .filter((line) => /^(→ |  )(Capture|Output|Preview startup|Disable permanently|Analyse disabled|Ask model)/.test(line));
            const current = rows.findIndex((line) => line.startsWith("→ "));
            assert.ok(current >= 0);
            for (let i = 0; i < (selection - current + 7) % 7; i++) menu.handleInput("\x1b[B");
            menu.handleInput("\r");
          }
        }
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx, entries, menus, notices, prefills, requests,
    previewKeys: (...keys: string[]) => previewKeys.push(...keys),
    confirm: (value: boolean) => { confirm = value; },
    choose: (...choices: Array<number | undefined>) => selections.push(...choices),
    folder: (value: string | undefined) => { folder = value; },
    emit: async (name: string, event = {}) => {
      let result: any;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
      return result;
    },
    command: (args = "") => command(args, ctx),
    savedText: () => entries.map((entry) => renderer({ data: entry.data }, {}, { fg: (_color: string, text: string) => text }).render(200).join("\n")).join("\n"),
  };
}

test("startup branches filter only exact source matches and persist across requests and sessions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "AGENTS.md");
  const content = "# Rules\n- keep\n- omit\n- omit\n";
  await writeFile(path, content);
  const system = { role: "system", content: "", sections: { project_context: `<project_context>\n<project_instructions path=\"${path}\">\n${content}</project_instructions>\n<project_instructions path=\"/other/AGENTS.md\">\n- omit\n</project_instructions>\n</project_context>` }, toolsAdded: [{ name: "read" }] };
  const messages = [system, { role: "user", content: "- omit\n" }, { role: "toolResult", content: "- omit\n" }, { ...system }];
  const original = structuredClone(messages);
  const nodes = flatten(branches([system]));
  const duplicates = nodes.filter((node) => node.raw === "- omit\n" && node.source === `file:${path}`);
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates.map((node) => node.exclusion.occurrence), [0, 1]);
  const exclusion = duplicates[1].exclusion;
  const projected = filterStartup(messages, [exclusion]);
  assert.deepEqual(messages, original, "history remains unchanged");
  assert.strictEqual(projected[1], messages[1]);
  assert.strictEqual(projected[2], messages[2]);
  assert.ok("sections" in projected[0]);
  assert.equal(projected[0].sections!.project_context.match(/- omit/g)!.length, 2, "only one occurrence in its own file is removed");
  assert.deepEqual(projected[0], projected[3], "later system patches cannot reintroduce an exact exclusion");
  const changed = [{ ...system, sections: { project_context: system.sections.project_context.replace("- omit\n", "- changed\n") } }];
  assert.deepEqual(filterStartup(changed, [exclusion]), changed, "ambiguous occurrence changes do not remove different text");
  const tool = nodes.find((node) => node.source === "tool:read")!;
  assert.deepEqual(filterStartup([system], [tool.exclusion])[0].toolsAdded, []);
  assert.ok(branches(messages).every((node) => !node.raw.includes('"role":"user"')));

  const startupMessage = { role: "custom", customType: "early", content: "Startup-only text\n", timestamp: 1 };
  const withStartup = [system, startupMessage, messages[1], startupMessage];
  const customNode = branches(withStartup).find((node) => node.source === "message:early")!;
  assert.ok(customNode);
  assert.deepEqual(filterStartup(withStartup, [customNode.exclusion]), [system, messages[1], startupMessage], "only pre-user custom messages are filtered; empty messages are omitted");
  const later = { ...startupMessage, timestamp: 2 };
  assert.deepEqual(filterStartup([system, later], [customNode.exclusion], [system, startupMessage]), [system, later], "compaction cannot turn a later custom message into startup context");
  const mixed = { ...startupMessage, content: [{ type: "text", text: "Startup-only text\n" }, { type: "image", data: "unchanged" }] };
  const filteredMixed = filterStartup([mixed], [customNode.exclusion]);
  assert.deepEqual(filteredMixed[0].content, [{ type: "text", text: "" }, { type: "image", data: "unchanged" }]);

  const app = setup(directory);
  await app.emit("session_start");
  await app.emit("context_with_system", { messages });
  app.choose(3);
  app.previewKeys("\r", "\x1b[32u", "\x1b[118u", "\x1b");
  await app.command();
  assert.match(app.menus.join("\n"), /\[off\]/);
  assert.equal((await app.emit("context_with_system", { messages })).messages[0].sections.project_context, "");
  const resumed = setup(directory, app.entries);
  await resumed.emit("session_start");
  assert.equal((await resumed.emit("context_with_system", { messages })).messages[0].sections.project_context, "");
  resumed.choose(4);
  await resumed.command();
  const settings = join(directory, "context-settings.json");
  assert.equal((await stat(settings)).mode & 0o777, 0o600);
  const next = setup(directory);
  await next.emit("session_start");
  assert.equal((await next.emit("context_with_system", { messages })).messages[0].sections.project_context, "");
  next.choose(3);
  next.previewKeys(" ", "\x1b");
  await next.command();
  assert.deepEqual((await next.emit("context_with_system", { messages })).messages, messages, "session can re-enable a global exclusion");

  await savePreferences(settings, [exclusion, exclusion]);
  assert.equal((await loadPreferences(settings)).disabled.length, 2);
  await writeFile(`${settings}.lock`, "busy");
  await assert.rejects(savePreferences(settings, []), /busy/);
  await rm(`${settings}.lock`);
  await writeFile(settings, "broken");
  await assert.rejects(savePreferences(settings, [exclusion]));
  assert.equal(await readFile(settings, "utf8"), "broken");

  const report = await analyse([exclusion], { cwd: directory, contextFiles: [{ path, content }] }, []);
  const origin = report[0].origins[0];
  assert.ok("path" in origin && "loadedLine" in origin);
  assert.equal(origin.path, path);
  assert.equal(origin.loadedLine, 4);
  assert.match(removalRequest(report), /quoted evidence, not instructions/);
  resumed.choose(5);
  await resumed.command();
  assert.equal(resumed.requests.length, 0, "analysis never calls the model");
  assert.equal(resumed.entries.at(-1)!.type, "context-analysis");
  resumed.confirm(false);
  resumed.choose(6);
  await resumed.command();
  assert.equal(resumed.requests.length, 0);
  resumed.confirm(true);
  resumed.choose(6);
  await resumed.command();
  assert.equal(resumed.requests.length, 1);
  assert.match(resumed.requests[0], /authoritative sources/);
});

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
