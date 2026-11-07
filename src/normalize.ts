import { parseDocument } from "yaml";
import { codeSpan, markdown, markdownContainer } from "./markdown.ts";

const MAX_DEPTH = 64;
const NAME = "[A-Za-z_][\\w:.-]*";
const ATTRS = `(?:\\s+${NAME}\\s*=\\s*(?:"[^"\\n]*"|'[^'\\n]*'))*`;
const opening = new RegExp(`^<(${NAME})(${ATTRS})\\s*>$`);
const inline = new RegExp(`^<(${NAME})(${ATTRS})\\s*>([^<>]*)</\\1\\s*>$`);
const closing = new RegExp(`^</(${NAME})\\s*>$`);

function json(text: string): { value: unknown } | undefined {
  if (!/^[\[{]/.test(text.trimStart())) return;
  try {
    JSON.parse(text); // Accept JSON only, not YAML-like prose.
    const document = parseDocument(text, { schema: "json", intAsBigInt: true, uniqueKeys: true });
    if (!document.errors.length) return { value: document.toJS() };
  } catch { /* Invalid or ambiguous JSON remains text. */ }
}

function attributes(source: string): Record<string, string> | undefined {
  const entries = [...source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => [match[1], match[2] ?? match[3]]);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return;
  return Object.fromEntries(entries);
}

// Find an entire standalone JSON block without interpreting braces inside strings.
function jsonEnd(lines: string[], start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if ((char === "}" || char === "]") && --depth <= 0) return i;
    }
  }
  return lines.length - 1;
}

interface Frame {
  tag?: string;
  attributes?: Record<string, string>;
  sections: unknown[];
  text: string;
}

function flush(frame: Frame) {
  if (frame.text.trim()) {
    const content = markdown(frame.text);
    if (typeof content === "string") frame.sections.push({ text: content });
    else frame.sections.push(...content);
  }
  frame.text = "";
}

function finish(frame: Frame): unknown {
  if (!frame.sections.length) return markdown(frame.text);
  flush(frame);
  return { sections: frame.sections };
}

function normalizeText(text: string, depth: number): unknown {
  const firstLine = text.replace(/^(?:[ \t]*\r?\n)+/, "");
  const whole = /^(?: {4}|\t)/.test(firstLine) ? undefined : json(text);
  if (whole) return normalize(whole.value, depth + 1);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const stack: Frame[] = [{ sections: [], text: "" }];
  let fence: string | undefined;
  let span: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const frame = stack[stack.length - 1];
    const marker = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (fence) {
      frame.text += line;
      if (marker && marker[2][0] === fence[0] && marker[2].length >= fence.length && !marker[3].trim()) fence = undefined;
      continue;
    }
    if (span !== undefined) {
      frame.text += line;
      span = codeSpan(line, span);
      continue;
    }
    // Backticks/fences inside literal HTML cannot change Markdown parser state.
    if ((marker || line.includes("`")) && markdownContainer(frame.text + line) === "html") {
      frame.text += line;
      continue;
    }
    if (marker) {
      fence = marker[2];
      frame.text += line;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      frame.text += line;
      continue;
    }
    const single = inline.exec(trimmed);
    const open = opening.exec(trimmed);
    const close = closing.exec(trimmed);
    const startsJson = /^[\[{]/.test(trimmed);
    if (single || open || close || startsJson) {
      const container = markdownContainer(frame.text + line);
      // A wrapper's closing tag still ends its content, even after a final list.
      const endsWrapper = close && frame.tag === close[1] && container === "list";
      if (container && !endsWrapper) {
        frame.text += line;
        continue;
      }
    }
    if (startsJson) {
      const end = jsonEnd(lines, i);
      const source = lines.slice(i, end + 1).join("");
      const parsed = json(source);
      if (parsed) {
        flush(frame);
        frame.sections.push({ json: normalize(parsed.value, depth + stack.length) });
      } else frame.text += source;
      i = end;
      continue;
    }
    if (single || open) {
      const match = (single ?? open)!;
      if (depth + stack.length >= MAX_DEPTH) return text;
      const attrs = attributes(match[2]);
      if (!attrs) return text;
      const tag = { tag: match[1], ...(Object.keys(attrs).length ? { attributes: attrs } : {}) };
      flush(frame);
      if (single) frame.sections.push({ ...tag, content: normalize(single[3], depth + stack.length) });
      else stack.push({ ...tag, sections: [], text: "" });
    } else if (close) {
      if (stack.length === 1 || frame.tag !== close[1]) return text;
      stack.pop();
      stack[stack.length - 1].sections.push({
        tag: frame.tag, ...(frame.attributes ? { attributes: frame.attributes } : {}), content: finish(frame),
      });
    } else {
      frame.text += line;
      span = codeSpan(line);
    }
  }
  // Do not reinterpret malformed or mismatched tag structures.
  return stack.length === 1 ? finish(stack[0]) : text;
}

/** A derived reading view, never a replacement for the provider payload. */
export function normalize(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return value;
  if (typeof value === "string") return normalizeText(value, depth);
  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, depth + 1)]));
  }
  return value;
}
