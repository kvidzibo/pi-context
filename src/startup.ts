import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { normalize } from "./normalize.ts";
import type { Exclusion } from "./preferences.ts";

export interface StartupMessage {
  role: string;
  customType?: string;
  timestamp?: number;
  content?: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: { name: string }[];
}
export interface Branch {
  id: string;
  label: string;
  raw: string;
  source: string;
  exclusion: Exclusion;
  children: Branch[];
}
export const exclusionKey = (value: Exclusion) => JSON.stringify([value.source, value.text, value.occurrence, value.count]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (text: string) => JSON.stringify(text.trim());

function positions(text: string, part: string): number[] {
  const result: number[] = [];
  if (!part) return result;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) result.push(at);
  return result;
}

/** Source-preserving reading tree. No YAML is ever converted back into instructions. */
export function textBranch(raw: string, source = "prompt", label = "system", depth = 0): Branch {
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const children: Branch[] = [];
  for (let i = 0; i < lines.length && depth < 64;) {
    const start = i;
    const line = lines[i].trim();
    const open = /^<([\w:.-]+)(?:\s[^<>]*)?>$/.exec(line);
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const fence = /^(`{3,}|~{3,})/.exec(line);
    let end = i + 1;
    let name = `text: ${quote(lines[i])}`;
    let childSource = source;
    if (fence) {
      while (end < lines.length) {
        const close = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[end++].trim());
        if (close) break;
      }
      name = "code: |";
    } else if (open) {
      let balance = 1;
      while (end < lines.length && balance) {
        const candidate = lines[end++].trim();
        if (candidate === `</${open[1]}>`) balance--;
        else if (new RegExp(`^<${open[1]}(?:\\s[^<>]*)?>$`).test(candidate)) balance++;
      }
      if (balance) end = i + 1;
      else {
        const path = open[1] === "project_instructions" ? /\bpath="([^"]+)"/.exec(line)?.[1] : undefined;
        childSource = path ? `file:${path}` : source === "prompt" ? `section:${open[1]}` : source;
        name = path ? `file: ${quote(path)}` : `${open[1]}:`;
      }
    } else if (heading) {
      while (end < lines.length) {
        const next = /^(#{1,6})\s+/.exec(lines[end].trim());
        if (next && next[1].length <= heading[1].length) break;
        end++;
      }
      name = `heading: ${quote(heading[2])}`;
    }
    // Wrapper delimiters have no significant trailing line break. This keeps their
    // identity stable when Pi moves a section between the head and a later patch.
    const joined = lines.slice(start, end).join("");
    const text = open && end > start + 1 ? joined.replace(/\r?\n$/, "") : joined;
    if (text.trim()) {
      let child: Branch;
      if (end > start + 1 && !fence) {
        // Parse the body, retaining wrappers in the selectable parent range.
        const body = lines.slice(start + 1, open ? end - 1 : end).join("");
        child = textBranch(body, childSource, name, depth + 1);
        child.raw = text;
        child.label = name;
      } else child = { id: "", label: name, raw: text, source: childSource, exclusion: { source: childSource, text, occurrence: 0, count: 1 }, children: [] };
      children.push(child);
    }
    i = end;
  }
  const root: Branch = children.length === 1 && children[0].raw === raw && children[0].source === source
    ? { ...children[0], label }
    : { id: "", label, raw, source, exclusion: { source, text: raw, occurrence: 0, count: 1 }, children };
  // Each source boundary owns its own match space; nested branches share that space.
  function assign(node: Branch, owner: Branch, at: number) {
    if (node.source !== owner.source) { owner = node; at = 0; }
    const found = positions(owner.raw, node.raw);
    node.exclusion = { source: node.source, text: node.raw, occurrence: Math.max(0, found.indexOf(at)), count: Math.max(1, found.length) };
    node.id = hash(exclusionKey(node.exclusion));
    let cursor = node.raw === owner.raw ? 0 : at;
    for (const child of node.children) {
      const next = owner.raw.indexOf(child.raw, cursor);
      assign(child, owner, next);
      cursor = next + child.raw.length;
    }
  }
  assign(root, root, 0);
  return root;
}

function promptParts(message: StartupMessage): string[] {
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "text").map((block) => block.text as string).join("\n") : "";
  return [content, ...Object.values(message.sections ?? {}).filter((text): text is string => text !== null)].filter(Boolean);
}

const messageSource = (message: StartupMessage) => message.role === "custom" ? `message:${message.customType ?? "custom"}` : "prompt";

export function branches(messages: StartupMessage[]): Branch[] {
  const result: Branch[] = [];
  for (const message of messages) {
    if (message.role === "user") break;
    if (message.role !== "system" && message.role !== "custom") continue;
    const text = promptParts(message).join("\n\n");
    if (text) result.push(textBranch(text, messageSource(message), message.role === "system" ? "system:" : `message: ${quote(message.customType ?? "custom")}`));
    for (const tool of message.toolsAdded ?? []) {
      const raw = JSON.stringify(tool);
      const exclusion = { source: `tool:${tool.name}`, text: raw, occurrence: 0, count: 1 };
      result.push({ id: hash(exclusionKey(exclusion)), label: `tool: ${quote(tool.name)}`, raw, source: exclusion.source, exclusion, children: [] });
    }
  }
  return result;
}

export function flatten(nodes: Branch[]): Branch[] { return nodes.flatMap((node) => [node, ...flatten(node.children)]); }
export function normalizedBranch(node: Branch): string {
  return stringify(normalize(node.raw), { lineWidth: 0, blockQuote: "literal" });
}

/** Apply exact startup matches and system patches, never user/assistant/tool-result content. */
export function filterStartup<T extends StartupMessage>(messages: T[], disabled: Exclusion[], startup?: StartupMessage[]): T[] {
  if (!disabled.length) return messages;
  const keys = new Set(disabled.map(exclusionKey));
  let beforeUser = true;
  return messages.flatMap((message) => {
    if (message.role === "user") beforeUser = false;
    const initialCustom = beforeUser && message.role === "custom" && (!startup || startup.some((initial) =>
      initial.role === "custom" && initial.customType === message.customType && initial.timestamp === message.timestamp));
    if (message.role !== "system" && !initialCustom) return message;
    const root = textBranch(promptParts(message).join("\n\n"), messageSource(message));
    const ranges: [number, number][] = [];
    function visit(node: Branch, start: number) {
      if (keys.has(exclusionKey(node.exclusion))) { ranges.push([start, start + node.raw.length]); return; }
      let cursor = 0;
      for (const child of node.children) {
        const at = node.raw.indexOf(child.raw, cursor);
        visit(child, start + at);
        cursor = at + child.raw.length;
      }
    }
    visit(root, 0);
    let offset = 0;
    const filter = (text: string, separator = 2, keepEmpty = false) => {
      if (!text && !keepEmpty) return text;
      const start = offset;
      offset += text.length + separator;
      let cursor = 0;
      let output = "";
      for (const [from, to] of ranges) {
        if (to <= start || from >= start + text.length) continue;
        output += text.slice(cursor, Math.max(0, from - start));
        cursor = Math.min(text.length, to - start);
      }
      return output + text.slice(cursor);
    };
    let content = message.content;
    if (typeof content === "string") content = filter(content);
    else if (Array.isArray(content)) {
      const textBlocks = content.filter((block) => block.type === "text");
      if (textBlocks.map((block) => block.text).join("\n")) {
        let index = 0;
        content = content.map((block) => block.type === "text"
          ? { ...block, text: filter(block.text, ++index === textBlocks.length ? 2 : 1, true) } : block);
      }
    }
    if (message.role === "custom" && (content === "" || (Array.isArray(content) && content.every((block) => block.type === "text" && !block.text)))) return [];
    return { ...message,
      content,
      ...(message.sections ? { sections: Object.fromEntries(Object.entries(message.sections).map(([name, text]) =>
        [name, text === null ? null : filter(text)])) } : {}),
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter((tool) => !keys.has(exclusionKey({ source: `tool:${tool.name}`, text: JSON.stringify(tool), occurrence: 0, count: 1 }))) } : {}),
    };
  });
}
