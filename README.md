# pi-context

[GitHub](https://github.com/kvidzibo/pi-context)

Save Pi provider requests as JSON, YAML, or normalized YAML without changing requests sent to the model.

## Install

From GitHub:

```bash
pi install git:github.com/kvidzibo/pi-context
```

After the first npm release:

```bash
pi install npm:@kvidzibo/pi-context
```

Requires Node.js 22.19+ and Pi's `before_provider_request` hook and custom-entry renderer; validated with Pi 1.5.0. Restart Pi after installing. After editing a loaded extension, use `/reload`.

## Usage

Run `/context` to open Pi's native settings list:

| Setting | Action |
| --- | --- |
| Capture | Toggle saving on/off; defaults off |
| Output | Cycle JSON → YAML → Normalized YAML → JSON |
| Output directory | Edit the prefilled, unique temporary path |

Use the configured selection keys (normally ↑/↓ and Enter or Space); Esc closes. Settings apply immediately. Editing the directory uses Pi's editor; Esc returns without changing it. Relative paths resolve from the session's working directory; `~` is supported. Missing directories are created with mode `0700`. Existing directory permissions are unchanged.

Choosing a format or directory does not enable capture. Enable **Capture** to save each future provider request, including tool follow-ups. Capture off pauses saving. All settings are session-local and reset on session switch or `/reload`: capture off, JSON output, and a new temporary path. Nothing is saved retroactively.

At each turn's end, a display-only transcript entry lists saved paths. These entries never enter model context. Write errors are reported without blocking requests or claiming success.

### Output formats

- **JSON** (`.json`): pretty-printed provider request data.
- **YAML** (`.yml`): the same data, with literal blocks for multiline strings where possible. This is a readable serialization, not the original JSON wire format.
- **Normalized YAML** (`.normalized.yml`): a labeled, transformed reading view. Paired standalone tags become ordered sections with attributes and content. Embedded JSON objects/arrays become structures, including nested encoded JSON. Markdown headings, paragraphs, lists, and separators become ordered blocks; list nesting and numbering are retained.

Normalization is conservative, not a general document converter. Inline syntax, code, blockquotes, HTML comments, malformed tags, and invalid/duplicate-key JSON remain literal. Tags and JSON inside lists stay within their items. Blank prose lines are omitted; code whitespace and original empty JSON fields are preserved. Quoted attributes are not entity-decoded. Parsing stops at 64 nested levels. Use JSON or YAML when original values matter.

## Privacy and limitations

- Files contain **unredacted** requests: prompts, tool output, secrets in context, and embedded images may be included. Files use mode `0600` and unique names. They are not automatically removed or size-limited; delete them when finished.
- No request history is retained in memory after saving. The extension does not reconstruct earlier requests from session history.
- The captured payload is the request body at this hook, not HTTP headers or proof of delivery. Later extensions can modify it; load this extension after request-transforming extensions for the closest view. SDK/provider transformations and remote prompt processing are outside its scope.
- Retries appear separately only when the provider invokes the hook again. Separate delegate processes need their own loaded extension; this package does not aggregate them.
- The settings menu requires interactive TUI mode. There is no in-app transcript viewer.

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
