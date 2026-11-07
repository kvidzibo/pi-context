# pi-context

[npm](https://www.npmjs.com/package/@kvidzibo/pi-context) · [GitHub](https://github.com/kvidzibo/pi-context)

Preview and disable Pi startup context, trace its sources, and save provider requests as JSON, YAML, or normalized YAML.

## Install

From GitHub:

```bash
pi install git:github.com/kvidzibo/pi-context
```

Or from npm:

```bash
pi install npm:@kvidzibo/pi-context
```

Requires Node.js 22.19+ and Pi 1.5.0+. Restart Pi after installing. After editing a loaded extension, use `/reload`.

## Usage

Run `/context` to open Pi's native settings list:

| Setting | Action |
| --- | --- |
| Capture | Toggle saving on/off; defaults off |
| Output | Cycle JSON → YAML → Normalized YAML → JSON |
| Output directory | Edit the prefilled, unique temporary path |
| Preview startup context | Expand/minimise and enable/disable startup branches |
| Disable permanently | Save disabled matches for new sessions, after confirmation |
| Analyse disabled lines | Print source evidence without calling a model |
| Ask model to remove | Confirm a model request to edit authoritative source files |

Use the configured selection keys (normally ↑/↓ and Enter or Space); Esc closes. Settings apply immediately. Editing the directory uses Pi's editor; Esc returns without changing it. Relative paths resolve from the session's working directory; `~` is supported. Missing directories are created with mode `0700`. Existing directory permissions are unchanged.

### Startup preview and exclusions

The YAML-style tree shows initial system instructions and tool declarations, not conversation history. Enter or ←/→ expands/minimises; Space toggles a branch; **v** opens its full normalized YAML; Esc goes back. Parent exclusions cover descendants. Tool declarations are selectable only as whole tools; their schemas are read-only.

Before the first request, the preview is **provisional**: extensions and tool-loadout preparation can still change it. The first request records the system prefix before the first non-system message. This snapshot remains the preview for that session. Later chat messages and tool results are never included or filtered.

Exclusions and expansion state persist in the active session branch across `/reload`, resume, and forks. Filtering runs on each normal model call, including tool follow-ups, and also removes exact matches from later system patches. It does not rewrite stored history. Source scope, exact text, and duplicate occurrence/count must match; changed or ambiguous branches remain enabled. **Analyse disabled lines** identifies exclusions that no longer match the startup snapshot.

**Disable permanently** merges exclusions into `$PI_CODING_AGENT_DIR/context-settings.json` (normally `~/.pi/agent/context-settings.json`), not Pi's main settings file. New sessions inherit them; existing sessions retain their choices. Re-enabling a branch overrides the exclusion for that session only. To remove permanent exclusions, edit this file's `disabled` array; then start a new session. Failed or malformed settings writes are reported without replacing the file. An interrupted write can leave a `.lock`; remove it only after verifying no other writer is running.

**Analyse disabled lines** prints loaded file paths and matching line numbers, symlink targets, changed-file warnings, tool provenance, and generated-file source headers where available. Built-in, CLI, and extension-generated text may have no exposed file origin; the report says so rather than guessing. It is a display-only session entry.

**Ask model to remove** explicitly sends disabled text back as quoted evidence in a confirmed user request. It asks the model to verify sources, edit authoritative files rather than generated outputs, regenerate and validate, and ask about ambiguous origins. The extension itself does not edit instruction files. Reload or a new session may be necessary after those edits.

### Request capture

Choosing a format or directory does not enable capture. Enable **Capture** to save each future provider request, including tool follow-ups. Capture off pauses saving. Capture settings are session-local and reset on session switch or `/reload`: capture off, JSON output, and a new temporary path. Startup exclusions and expansion state are retained. Nothing is saved retroactively.

At each turn's end, a display-only transcript entry lists saved paths. These entries never enter model context. Write errors are reported without blocking requests or claiming success.

### Output formats

- **JSON** (`.json`): pretty-printed provider request data.
- **YAML** (`.yml`): the same data, with literal blocks for multiline strings where possible. This is a readable serialization, not the original JSON wire format.
- **Normalized YAML** (`.normalized.yml`): a labeled, transformed reading view. Paired standalone tags become ordered sections with attributes and content. Embedded JSON objects/arrays become structures, including nested encoded JSON. Markdown headings, paragraphs, lists, and separators become ordered blocks; list nesting and numbering are retained.

Normalization is conservative, not a general document converter. Inline syntax, code, blockquotes, HTML comments, malformed tags, and invalid/duplicate-key JSON remain literal. Tags and JSON inside lists stay within their items. Blank prose lines are omitted; code whitespace and original empty JSON fields are preserved. Quoted attributes are not entity-decoded. Parsing stops at 64 nested levels. Use JSON or YAML when original values matter.

## Privacy and limitations

- Files contain **unredacted** requests: prompts, tool output, secrets in context, and embedded images may be included. Files use mode `0600` and unique names. They are not automatically removed or size-limited; delete them when finished.
- The startup snapshot and exclusions contain **unredacted** instructions and tool declarations. They are stored in session entries; permanent settings contain the excluded text. Treat both as sensitive. Full captured requests are not retained in memory after saving.
- Exclusions are not a security boundary or a tool-execution permission system. They cannot erase prior requests, assistant recollections, provider-owned prompts, or text repeated in conversation. Compaction and other auxiliary model calls are outside the normal request hook.
- The captured payload is the request body at this hook, not HTTP headers or proof of delivery. Later extensions can modify it; load this extension after request-transforming extensions for the closest view. SDK/provider transformations and remote prompt processing are outside its scope.
- Retries appear separately only when the provider invokes the hook again. Separate delegate processes need their own loaded extension; this package does not aggregate them.
- The settings menu requires interactive TUI mode. Context changes are allowed only while idle. Load after extensions that change prompts: later hooks can reintroduce text. Unsupported or malformed prompt markup remains literal; normalization never replaces the original request text.

## Develop and validate

```bash
npm ci --ignore-scripts
pi -e ./index.ts
npm run check
dbus-run-session -- xvfb-run -a npm test
npm pack --dry-run
```

The test wrapper requires `dbus-run-session`, `xvfb-run`, and `xauth`. Tests make no model requests.

## Publishing

Package: `@kvidzibo/pi-context`. The initial public release is **0.3.0**.

One-time bootstrap after review: run `npm login` and `npm publish --ignore-scripts` for the first release. In npm package settings, add a GitHub Actions trusted publisher: owner **kvidzibo**, repository **pi-context**, workflow **publish.yml**, no environment. Allow direct `npm publish`. CI uses OIDC, not an npm token secret.

Later releases bump `package.json` and `package-lock.json` together in a PR. Every push to `main` runs tests on Node 22.19 and 24, then publishes new stable versions publicly with provenance. Existing versions are skipped; registry lookup failures stop publishing. No release tag is needed. Pull requests run the same checks without publishing.

## License

[MIT](LICENSE).
