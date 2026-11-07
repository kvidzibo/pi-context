import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { normalize } from "./normalize.ts";

export type SaveFormat = "JSON" | "YAML" | "Normalized YAML";

// Paths and errors can contain untrusted terminal control characters.
export function terminalSafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function saveRequest(payload: unknown, directory: string, format: SaveFormat): Promise<string> {
  const json = JSON.stringify(payload, null, 2) ?? "null";
  const extension = format === "JSON" ? ".json" : format === "YAML" ? ".yml" : ".normalized.yml";
  const path = join(directory, `request-${randomUUID()}${extension}`);
  const value = JSON.parse(json);
  const contents = format === "JSON" ? `${json}\n` : stringify(format === "YAML" ? value : {
    format: "pi-context-normalized-v1",
    note: "Transformed reading view; not the exact provider request. Unredacted. Use JSON or YAML for original values.",
    request: normalize(value),
  }, { blockQuote: "literal", lineWidth: 0 });
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
  return path;
}
