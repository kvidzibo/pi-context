import test from "node:test";
import assert from "node:assert/strict";
import { saveRequest, terminalSafe } from "../src/capture.ts";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

test("raw formats preserve request values and save privately without mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-raw-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = {
    instructions: "hello\nworld",
    messages: [{ content: "first\n\nlast\n\n" }],
    escaped: "literal \\n stays escaped",
    quoted: ["true", "null", "2026-11-07", "123", "# comment", ""],
    controls: "tab\there\r\nnext\u001b",
    stream: true, limit: 0, metadata: null,
  };
  const snapshot = structuredClone(payload);
  for (const format of ["JSON", "YAML"] as const) {
    const path = await saveRequest(payload, directory, format);
    const saved = await readFile(path, "utf8");
    assert.ok(path.endsWith(format === "JSON" ? ".json" : ".yml"));
    if (format === "YAML") assert.match(saved, /instructions: \|-\n  hello\n  world\n/);
    assert.deepEqual(format === "JSON" ? JSON.parse(saved) : parse(saved), payload);
    assert.deepEqual(payload, snapshot);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal(terminalSafe("\x1b[31m\n"), "\\u001b[31m\\u000a");
});
