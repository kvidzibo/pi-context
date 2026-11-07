import { join } from "node:path";
import { stringify } from "yaml";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import { terminalSafe } from "./capture.ts";
import { branches, filterStartup, flatten, exclusionKey, type StartupMessage } from "./startup.ts";
import { isExclusion, loadPreferences, savePreferences, type Exclusion } from "./preferences.ts";
import { preview } from "./preview.ts";
import { analyse, removalRequest } from "./provenance.ts";

const STATE = "context-controls";
const SNAPSHOT = "context-startup";
export function startupControls(pi: ExtensionAPI) {
  let disabled: Exclusion[] = [];
  let expanded = new Set<string>();
  let snapshot: StartupMessage[] | undefined;
  let forcedOriginal: string | undefined;
  const settingsPath = join(getAgentDir(), "context-settings.json");
  const persist = () => pi.appendEntry(STATE, { disabled: structuredClone(disabled), expanded: [...expanded] });
  const warn = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(terminalSafe(String(error)), "error");

  async function restore(ctx: ExtensionContext) {
    disabled = [];
    expanded = new Set();
    snapshot = undefined;
    forcedOriginal = undefined;
    try { disabled = (await loadPreferences(settingsPath)).disabled; }
    catch (error) { warn(ctx, error); }
    let restored = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === STATE) {
        const data = entry.data as { disabled?: unknown; expanded?: unknown } | undefined;
        if (Array.isArray(data?.disabled) && data.disabled.every(isExclusion)) {
          disabled = structuredClone(data.disabled);
          restored = true;
        }
        if (Array.isArray(data?.expanded) && data.expanded.every((value) => typeof value === "string")) expanded = new Set(data.expanded);
      }
      if (entry.customType === SNAPSHOT && Array.isArray(entry.data)) snapshot = structuredClone(entry.data);
    }
    if (!restored) persist();
  }
  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", (event) => {
    // Pi reapplies forced prompts after context_with_system, so filter the override too.
    forcedOriginal = event.systemPromptOptions.forceSystemPrompt;
    if (forcedOriginal !== undefined) {
      event.systemPromptOptions.forceSystemPrompt = filterStartup([{ role: "system", content: forcedOriginal }], disabled)[0].content;
    }
  });
  pi.on("context_with_system", (event) => {
    if (!snapshot) {
      const first = event.messages.findIndex((message) => message.role === "user");
      snapshot = structuredClone(event.messages.slice(0, first < 0 ? undefined : first));
      if (forcedOriginal !== undefined && snapshot[0]) {
        snapshot[0].content = forcedOriginal;
        delete snapshot[0].sections;
      }
      pi.appendEntry(SNAPSHOT, snapshot);
    }
    return { messages: filterStartup(event.messages, disabled, snapshot) };
  });
  pi.registerEntryRenderer<{ report: string }>("context-analysis", (entry, _options, theme) =>
    new Text(theme.fg("dim", (entry.data?.report ?? "").split("\n").map(terminalSafe).join("\n")), 1, 0));

  function initial(ctx: ExtensionCommandContext): StartupMessage[] {
    if (snapshot) return snapshot;
    const messages: StartupMessage[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "user") break;
      if (entry.type === "message" && entry.message.role === "system") messages.push(entry.message);
      if (entry.type === "custom_message") messages.push({ role: "custom", customType: entry.customType, content: entry.content, timestamp: new Date(entry.timestamp).getTime() });
    }
    if (messages.some((message) => message.role === "system")) return messages;
    const active = new Set(pi.getActiveTools());
    return [{ role: "system", content: ctx.getSystemPrompt(), toolsAdded: pi.getAllTools().filter((tool) => active.has(tool.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters })) }, ...messages];
  }
  return {
    items(): SettingItem[] {
      return [
        { id: "preview", label: "Preview startup context", currentValue: `${disabled.length} disabled`, values: ["open"], description: "Expand/minimise branches; disable instructions for future requests. Before the first request, this is a provisional preview." },
        { id: "permanent", label: "Disable permanently", currentValue: "save", values: ["save"], description: "Export exact disabled matches to private context settings for other sessions." },
        { id: "analyse", label: "Analyse disabled lines", currentValue: "print sources", values: ["print sources"], description: "Print known source files and line numbers without calling a model." },
        { id: "remove", label: "Ask model to remove", currentValue: "confirm…", values: ["confirm…"], description: "Ask the model to edit verified source files. Disabled text is included as quoted evidence." },
      ];
    },
    async handle(action: string, ctx: ExtensionCommandContext): Promise<boolean> {
      if (!["preview", "permanent", "analyse", "remove"].includes(action)) return false;
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current response before changing context.", "warning"); return false; }
      try {
        const roots = branches(initial(ctx));
        if (action === "preview") {
          await preview(ctx, roots, disabled, expanded, persist);
          return false;
        }
        if (!disabled.length) { ctx.ui.notify("No disabled branches.", "info"); return false; }
        if (action === "permanent") {
          if (await ctx.ui.confirm("Disable permanently?", `Save ${disabled.length} exact exclusions to ${settingsPath}? New sessions will reuse them. Source files are not edited.`)) {
            await savePreferences(settingsPath, disabled);
            ctx.ui.notify("Disabled context saved for new sessions.", "info");
          }
          return false;
        }
        const known = new Set(flatten(roots).map((node) => exclusionKey(node.exclusion)));
        const report = (await analyse(disabled, ctx.getSystemPromptOptions(), pi.getAllTools())).map((item, index) => ({
          ...item, startupMatch: known.has(exclusionKey(disabled[index])) ? "exact" : "unmatched — source changed or unavailable",
        }));
        if (action === "analyse") {
          pi.appendEntry("context-analysis", { report: stringify(report, { lineWidth: 0 }) });
        } else if (await ctx.ui.confirm("Ask model to remove?", "This starts a model request with the disabled text as evidence and asks it to edit the authoritative source files. Continue?")) {
          pi.sendUserMessage(removalRequest(report));
          return true;
        }
      } catch (error) { warn(ctx, error); }
      return false;
    },
  };
}
