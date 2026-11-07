import { Lexer, type Token, type Tokens } from "marked";

export function codeSpan(line: string, length?: number): number | undefined {
  for (const match of line.matchAll(/(\\*)(`+)/g)) {
    if (length === undefined) {
      if (match[1].length % 2 === 0) length = match[2].length;
    } else if (match[2].length === length) length = undefined;
  }
  return length;
}

// Tag/JSON extraction must not split a surrounding Markdown container.
export function markdownContainer(text: string): "list" | "literal" | "html" | undefined {
  try {
    let token = Lexer.lex(text, { gfm: false, pedantic: false }).filter((item) => item.type !== "space").at(-1);
    const inList = token?.type === "list";
    while (token?.type === "list") {
      token = (token as Tokens.List).items.at(-1)?.tokens.filter((item) => item.type !== "space").at(-1);
    }
    if (token?.type === "html" && /^\s*<(?:!--|\?|!\[CDATA\[|(?:script|style|pre|textarea)\b)/i.test(token.raw)) return "html";
    if (token?.type === "code" || token?.type === "blockquote") return "literal";
    return inList ? "list" : undefined;
  } catch {
    return "literal";
  }
}

function blocks(tokens: Token[], depth = 0): { content: unknown[]; structured: boolean } {
  const content: unknown[] = [];
  let structured = false;
  let span: number | undefined;
  let literal = "";
  const flush = () => {
    if (literal) content.push({ text: literal });
    literal = "";
  };
  for (const token of tokens) {
    // Be more conservative than Markdown's block precedence for multiline code spans.
    const nextSpan = span !== undefined || ["text", "paragraph", "heading"].includes(token.type)
      ? codeSpan(token.raw, span) : undefined;
    if (span !== undefined || nextSpan !== undefined) {
      literal += token.raw;
      span = nextSpan;
      continue;
    }
    flush();
    switch (token.type) {
      case "space": break;
      case "heading":
        content.push({ heading: { level: token.depth, text: token.text } });
        structured = true;
        break;
      case "hr":
        content.push({ separator: true });
        structured = true;
        break;
      case "list": {
        if (depth >= 64) {
          content.push({ text: token.raw });
          break;
        }
        const list = token as Tokens.List;
        content.push({
          ...(list.ordered ? { ordered: true, start: list.start } : {}),
          items: list.items.map((item) => {
            const children = item.tokens.filter((child) => child.type !== "space");
            if (children.length === 1 && ["text", "paragraph"].includes(children[0].type)) return item.text;
            return { content: blocks(item.tokens, depth + 1).content };
          }),
        });
        structured = true;
        break;
      }
      case "paragraph":
      case "text":
        content.push({ text: token.text });
        break;
      default:
        // Code, HTML, quotes and reference definitions stay literal, never rendered.
        content.push({ text: token.raw });
    }
  }
  flush();
  return { content, structured };
}

/** Only expand prose when it contains supported Markdown structure. */
export function markdown(text: string): string | unknown[] {
  try {
    // CommonMark block parsing; inline syntax (including task markers) stays text.
    const tokens = Lexer.lex(text, { gfm: false, pedantic: false });
    const result = blocks(tokens);
    if (result.structured) return result.content;
    // Remove prose-only padding without touching literal blocks or multiline code spans.
    if (tokens.every((token) => ["space", "paragraph", "text"].includes(token.type)) &&
        !text.split(/\r?\n/).some((line) => codeSpan(line) !== undefined)) {
      const prose = tokens.flatMap((token) => token.type === "paragraph" || token.type === "text" ? [token.text] : []).join("\n");
      return prose && text.endsWith("\n") ? `${prose}\n` : prose;
    }
    return text;
  } catch {
    return text;
  }
}
