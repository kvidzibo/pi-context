import { mkdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DynamicBorder, getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import { saveRequest, terminalSafe, type SaveFormat } from "./capture.ts";

export default function contextInspector(pi: ExtensionAPI) {
  let capturing = false;
  let directory = suggestedDirectory();
  let format: SaveFormat = "JSON";
  let savedPaths: string[] = [];

  function suggestedDirectory() { return join(tmpdir(), `pi-context-${randomUUID()}`); }
  function reset() {
    capturing = false;
    directory = suggestedDirectory();
    format = "JSON";
    savedPaths = [];
  }
  async function prepareDirectory(path: string, cwd: string) {
    const input = path.trim();
    if (!input || /[\r\n\0]/.test(input)) throw new Error("Enter one folder path.");
    const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
    const resolved = resolve(cwd, expanded);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    return realpath(resolved);
  }
  function reportSaved() {
    if (savedPaths.length) pi.appendEntry("context-saved", { paths: savedPaths.splice(0) });
  }

  pi.registerEntryRenderer<{ paths: string[] }>("context-saved", (entry, _options, theme) =>
    new Text(theme.fg("dim", (entry.data?.paths ?? []).map((path) =>
      `Context request saved: ${terminalSafe(path)}`).join("\n")), 1, 0));
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("turn_end", reportSaved);
  pi.on("agent_end", reportSaved);
  pi.on("before_provider_request", async (event, ctx) => {
    if (!capturing) return;
    const paths = savedPaths;
    const output = format;
    try {
      paths.push(await saveRequest(event.payload, directory, output));
    } catch (error) {
      ctx.ui.notify(terminalSafe(`Could not save ${output} context request: ${error instanceof Error ? error.message : error}`), "error");
    }
  });

  pi.registerCommand("context", {
    description: "Save provider requests; choose output format and directory",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /context", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The context menu requires TUI mode.", "warning");
        return;
      }
      let selected = "capture";
      while (true) {
        const action = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
          const settings = new SettingsList([
            { id: "capture", label: "Capture", currentValue: capturing ? "on" : "off", values: ["off", "on"],
              description: "Save future requests, unredacted. Off pauses saving." },
            { id: "output", label: "Output", currentValue: format, values: ["JSON", "YAML", "Normalized YAML"],
              description: "Normalized YAML is a transformed reading view, not the exact request." },
            { id: "directory", label: "Output directory", currentValue: terminalSafe(directory), values: [terminalSafe(directory)],
              description: terminalSafe(directory) },
          ], 3, getSettingsListTheme(), (id, value) => {
            if (id === "output") format = value as SaveFormat;
            else done(id);
          }, () => done(undefined));
          settings.selectItem(selected);
          const container = new Container();
          container.addChild(new DynamicBorder());
          container.addChild(settings);
          container.addChild(new DynamicBorder());
          return Object.assign(container, {
            capturesViewportInput: true,
            handleInput(data: string) { settings.handleInput(data); tui.requestRender(); },
          });
        });
        if (!action) return;
        selected = action;
        try {
          if (action === "capture") {
            if (!capturing) directory = await prepareDirectory(directory, ctx.cwd);
            capturing = !capturing;
          } else if (action === "directory") {
            const folder = await ctx.ui.editor("Output directory (unredacted requests)", directory);
            if (folder !== undefined) directory = await prepareDirectory(folder, ctx.cwd);
          }
        } catch (error) {
          ctx.ui.notify(terminalSafe(error instanceof Error ? error.message : String(error)), "error");
        }
      }
    },
  });
}
