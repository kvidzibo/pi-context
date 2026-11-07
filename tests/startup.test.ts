import test from "node:test";
import assert from "node:assert/strict";
import { branches, filterStartup, flatten } from "../src/startup.ts";

test("startup tree boundaries and filtering keep code examples opaque", () => {
  const examples = [
    { code: "```markdown\n# Example heading, not a real section\nexample text\n```\n", wrapped: false },
    {
      code: '````markdown\n```\n# Example heading, not a real section\n</project_instructions>\n<project_instructions path="/fake.md">\n`````\n',
      wrapped: true,
    },
    {
      code: '  ~~~markdown\n# Example heading, not a real section\n</project_instructions>\n<project_instructions path="/fake.md">\n  ~~~~\n',
      wrapped: true,
    },
    {
      code: '    # Example heading, not a real section\n    </project_instructions>\n    <project_instructions path="/fake.md">\n\t# Tab example\n\t</project_instructions>\n',
      wrapped: true,
    },
    { code: "```markdown\n# Example heading, not a real section\n", wrapped: false, unclosed: true },
  ];
  for (const example of examples) {
    const rules = `# Rules\nKeep this rule.\n${example.code}Keep this too.\n`;
    const next = "# Next\nOther rule.\n";
    const before = example.wrapped ? '<project_instructions path="/real.md">\n' : example.unclosed ? "Unrelated preface.\n" : "";
    const after = example.wrapped ? "</project_instructions>\nUnrelated outside text.\n" : "";
    const raw = before + rules + next + after;
    const messages = [
      { role: "system", content: raw },
      { role: "user", content: raw },
      { role: "assistant", content: raw },
      { role: "toolResult", content: raw },
    ];
    const original = structuredClone(messages);
    const roots = branches(messages);
    const nodes = flatten(roots);
    const source = example.wrapped ? "file:/real.md" : "prompt";
    const ruleNode = nodes.find((node) => node.label === 'heading: "Rules"')!;
    assert.ok(ruleNode, example.code);
    assert.equal(ruleNode.raw, rules + (example.unclosed ? next : ""));
    assert.equal(ruleNode.source, source);
    assert.ok(nodes.filter((node) => node.label.startsWith("heading:")).every((node) =>
      !node.label.includes("Example heading") && !node.label.includes("Tab example")));
    assert.ok(nodes.every((node) => node.source === "prompt" || node.source === source));
    if (example.wrapped) {
      const wrapper = nodes.find((node) => node.source === source)!;
      assert.equal(wrapper.raw, (before + rules + next + "</project_instructions>"));
    }
    const filtered = filterStartup(messages, [ruleNode.exclusion]);
    assert.equal(filtered[0].content, before + (example.unclosed ? "" : next) + after);
    for (let i = 1; i < messages.length; i++) assert.strictEqual(filtered[i], messages[i]);
    assert.deepEqual(messages, original);
    if (!example.unclosed) {
      const nextNode = nodes.find((node) => node.label === 'heading: "Next"')!;
      assert.equal(nextNode.raw, next);
      assert.equal(nextNode.source, source);
      assert.equal(filterStartup(messages, [nextNode.exclusion])[0].content, before + rules + after);
      const tail = nodes.find((node) => node.raw === "Keep this too.\n")!;
      assert.ok(tail);
      assert.equal(filterStartup(messages, [tail.exclusion])[0].content, raw.replace("Keep this too.\n", ""));
    }
  }
});
