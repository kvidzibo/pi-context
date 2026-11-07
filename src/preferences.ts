import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface Exclusion {
  source: string;
  text: string;
  occurrence: number;
  count: number;
}

export interface Preferences {
  version: 1;
  disabled: Exclusion[];
}

export function isExclusion(value: unknown): value is Exclusion {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.source === "string" && item.source.length > 0 &&
    typeof item.text === "string" && item.text.length > 0 &&
    typeof item.occurrence === "number" && Number.isSafeInteger(item.occurrence) &&
    item.occurrence >= 0 &&
    typeof item.count === "number" && Number.isSafeInteger(item.count) &&
    item.count > 0 && item.occurrence < item.count
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function loadPreferences(path: string): Promise<Preferences> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { version: 1, disabled: [] };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" || value === null ||
    !("version" in value) || value.version !== 1 ||
    !("disabled" in value) || !Array.isArray(value.disabled) ||
    !value.disabled.every(isExclusion)
  ) {
    throw new Error(`Invalid preferences at ${path}`);
  }
  return { version: 1, disabled: value.disabled };
}

export async function savePreferences(path: string, disabled: Exclusion[]): Promise<void> {
  if (!Array.isArray(disabled) || !disabled.every(isExclusion)) {
    throw new Error("Invalid exclusions: refusing to save preferences");
  }
  // Snapshot caller-owned values before yielding, preserving exact text.
  const additions = disabled.map(({ source, text, occurrence, count }) => ({ source, text, occurrence, count }));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (hasCode(error, "EEXIST")) {
      throw new Error(`Preferences are busy: lock exists at ${lockPath}`);
    }
    throw error;
  });
  let temporaryPath: string | undefined;
  try {
    const latest = await loadPreferences(path);
    const seen = new Set<string>();
    const merged: Exclusion[] = [];
    for (const { source, text, occurrence, count } of [...latest.disabled, ...additions]) {
      const key = JSON.stringify([source, text, occurrence, count]);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ source, text, occurrence, count });
      }
    }
    const candidate = `${path}.${randomUUID()}.tmp`;
    const temporary = await open(candidate, "wx", 0o600);
    temporaryPath = candidate;
    try {
      await temporary.writeFile(`${JSON.stringify({ version: 1, disabled: merged }, null, 2)}\n`, "utf8");
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
    temporaryPath = undefined;
  } finally {
    try {
      if (temporaryPath !== undefined) await unlink(temporaryPath);
    } finally {
      try {
        await lock.close();
      } finally {
        await unlink(lockPath);
      }
    }
  }
}
