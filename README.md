# Export for Claude

A Chromium extension (Chrome, Brave and other Chromium browsers, Manifest V3)
that exports the open claude.ai conversation to Markdown, JSON or PDF, and
downloads its files as a zip. Everything runs locally in the browser: the
extension only talks to claude.ai, with your normal cookies. No server, no
analytics.

Not affiliated with or endorsed by Anthropic. The extension reads claude.ai's
internal, undocumented API, so a change on claude.ai can break it until it is
updated.

Works for regular chats, incognito chats, shared chats (`/share/…`) and
Cowork / Claude Code sessions. Design decisions are in [DESIGN.md](DESIGN.md).

The interface is available in English (default) and Swedish and follows the
browser's UI language. The exported Markdown and JSON are always in English.

## Install

A Chrome Web Store listing is planned. Until then, build it yourself and load
it unpacked as described below.

## Build

Requires Node 20 or later.

```sh
npm install
npm run build   # type check + build into dist/
npm test        # unit tests (vitest)
```

The tests against real exports read from `fixtures/private/` (not in git) and
are skipped when the files are missing.

## Load unpacked

1. Open `chrome://extensions` (or `brave://extensions` in Brave).
2. Turn on **Developer mode** in the top right.
3. Click **Load unpacked** and pick the `dist/` folder.
4. Pin the extension to the toolbar if you like.
5. Reload claude.ai tabs that were already open, otherwise the extension cannot reach them.

After a new `npm run build`: click the reload button on the extension's card
and reload the claude.ai tabs.

## Use

Open a conversation on claude.ai and click the extension's icon:

- **Export Markdown** saves `YYYY-MM-DD Title.md` (date = when the chat was created).
- **Export JSON** saves the same content as JSON.
- **Save as PDF** opens a print-friendly tab and the print dialog; choose
  "Save as PDF". Images are embedded, so they show even without being logged in
  in that tab.
- **Download files (N)** saves `YYYY-MM-DD Title – files.zip` with the files you
  uploaded and the files Claude sent (images, PDFs, documents, created files),
  with original names and original content. The button is disabled when there
  are no files. Tool screenshots, artifacts and pasted text are not included.
  If a file cannot be fetched, a zip with the rest is still saved, and
  `missing.txt` in the zip lists the ones that are missing.

Errors are shown in the popup (not logged in, not found, too many requests,
network error, not a claude.ai chat).

## Structure

- `src/core/` – pure logic without browser APIs: fetching behind an `Http`
  interface, branch selection, normalisation of the chat API and Cowork events,
  Markdown and JSON rendering, file collection and zip (`fflate`). Tested in
  Node. Texts that end up inside the zip (file name suffix, missing-files list)
  are passed in by the caller; the defaults are English.
- `src/extension/` – the extension's parts: `hook.ts` (MAIN world at
  `document_start`, observes the page's own requests), `content.ts`, `popup.*`,
  `print.*`, `background.ts`, `i18n.ts` (wrapper around `chrome.i18n`).
- `public/_locales/{en,sv}/messages.json` – the interface texts. English is the
  default locale; Swedish is shown when the browser's UI language is Swedish.
- `public/manifest.json` – the manifest. Permissions: `downloads`, `offscreen`
  and `https://claude.ai/*`.

## Release

Push a tag that matches the manifest version, for example `v1.0.0`. The
[Release workflow](.github/workflows/release.yml) runs the tests, builds and
attaches `export-for-claude-<version>.zip` to a GitHub release. That zip is what
gets uploaded to the Chrome Web Store; the listing texts and dashboard answers
are in [store/](store/).

## Privacy

No data is collected or sent anywhere except claude.ai. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
