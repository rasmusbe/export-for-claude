# Export for Claude – design

Own Chromium MV3 extension (Brave/Chrome) that exports the open claude.ai
conversation to Markdown, JSON and PDF. Everything runs locally: no server, no
login, no analytics. TypeScript + Vite.

Not affiliated with or endorsed by Anthropic. It reads claude.ai's internal,
undocumented JSON API, which can change without notice.

## Scope v1

- Conversation types: normal chats, Cowork / Claude Code remote sessions,
  incognito chats, shared chats (`/share/`). Not project pages.
- Always the whole conversation (no per-message selection).
- UI: toolbar popup with four buttons: Markdown, JSON, PDF and "Download files (N)" (zip of the conversation's files).
- Interface texts in English (default) and Swedish via `chrome.i18n` (see Localisation).
- No options page.

Later: bulk export, buttons inside claude.ai, other chat services.

## Data source

Fetch claude.ai's own JSON API from the content script (same origin, cookies
are sent automatically, plain `fetch(relativeUrl)`).

- Conversation id: last path segment of `/chat/{uuid}`, validated as UUID.
- Org id: `lastActiveOrg` cookie; fallback `GET /api/organizations` (first org
  with chat capability) when the cookie is missing or the request 403/404s.
- Normal chat:
  `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
- Branch: start at `current_leaf_message_uuid`, walk `parent_message_uuid` to
  the root. Legacy messages without parent: prepend everything before them in
  array order. No leaf: whole array. Then merge consecutive same-sender
  messages (concat `content`, `files_v2`, `files`, `attachments`,
  `sync_sources`).
- Shared chat: `GET /api/chat_snapshots/{id}?rendering_mode=messages&render_all_tools=true`.
- Incognito (`/new?incognito`): uuid never appears in the URL. A MAIN-world
  script at `document_start` wraps `window.fetch`, matches
  `^/api/organizations/(uuid)/chat_conversations/(uuid)/completion$` and posts
  `{orgId, convoId}` to the content script via `window.postMessage` (check
  `e.source === window` and origin). Also posts route changes
  (`pushState`/`replaceState`/`popstate`) so a stale id is cleared.
- Cowork / Claude Code remote sessions (UUIDv8 chat ids, i.e. char 14 is `8`,
  where the chat endpoint 404s; a non-v8 chat that 404s also tries the Cowork
  path, but only with ids the hook saw, never a full session listing):
  - Session events: `GET /v1/code/sessions/{cse_id}/events?limit=500&cursor=…`,
    headers `anthropic-version: 2023-06-01`, `x-organization-uuid: {org}`
    (without them the API answers 400). Pages come newest first; follow
    `next_cursor` until it is null (cap 200 pages), then sort by `sequence_num`.
    (`resume_cursor` is for live tailing and is not used.)
  - Session metadata: `GET /v1/code/sessions/{cse_id}` (same headers), wrapped
    in `response_shape` (`title`, `created_at`, `last_event_at`).
  - Mapping chat uuid → session id, in order:
    1. The MAIN-world hook sniffs `ReadCoworkSession` POSTs (request body holds
       one `cse_…`, response holds `continuation.conversationId`; JSON or
       protobuf, scanned as text) and caches the mapping.
    2. The hook records the page's own `GET /v1/code/sessions/{cse_id}`
       requests (the page loads the open chat's session) with the chat uuid in
       the URL at that moment. Candidates are verified with ReadCoworkSession;
       if the RPC is unavailable and exactly one candidate belongs to this
       chat, it is used as is.
    3. List `/v1/code/sessions?limit=100&tags=cowork-remote&include_trigger_sessions=true`
       (paged with `cursor=` + `next_cursor`, max 10 pages), verify sessions
       whose `title` equals the page title first, then the rest (max 300 RPCs).
    Verification: POST
    `/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadCoworkSession`
    with JSON `{sessionId, limit:1, metaOnly:true}` and headers
    `connect-protocol-version: 1`, `anthropic-client-platform: web_claude_ai`,
    `x-organization-uuid`; the JSON answer has `continuation.conversationId`.
  - Cowork thinking blocks carry no summaries and are not shown. Events with
    `payload.parent_tool_use_id` (subagents) are skipped entirely: neither
    their text nor their tool steps appear in the main turn.
- Errors: 401/403 → not logged in, 404 → not found, 429 → rate limited,
  network. Shown in the popup.

## Markdown format

Pinned by a golden test against a private reference export
(`fixtures/private/expected/`, not tracked). Dates are `YYYY-MM-DD HH:MM:SS`
(local time, zero padded), `<system-reminder>` blocks are stripped from user
messages, and subagent text is not rendered as assistant text.

```
# {title}

**Created:** {created}  
**Updated:** {updated}  
**Exported:** {now}  
**Link:** [{url}]({url})  

## User:

> {message time}

{body}

## Assistant:

> {message time}

> {step-group summary}
>
> - {step}
> - **Done**

{text}
```

- Step groups: each run of thinking + tool_use/tool_result blocks between text
  blocks becomes one blockquote. Thinking shows only its summary
  (`summaries[].summary`), never full text.
- Step names: `mcp__srv__method` → `Srv: method`; Read/Write/Edit →
  `Read|Created|Edited <basename>`; Bash → `input.description`; WebSearch →
  `Searched: q`; WebFetch → `Fetched: url`; Agent → `Tool: Agent`; otherwise
  `tool_use.message` / `input.description` / `input.query` / `Tool: name`.
- Summary line: chat → from thinking summary, else counts per tool
  ("Searched the web", "Ran command", …). Cowork → parts like "Used N tools",
  "loaded tools", "used {Server} integration", "searched the web",
  "read/created/edited N files", "ran N commands", joined with ", ",
  first letter capitalised.
- Artifacts: replay create/update(old_str→new_str)/rewrite; output
  `**Title** ∙ Version N` + fenced block. Hide update + "OK" result pairs.
- Sources: collect web_search `knowledge` items per turn, dedupe by url, append
  `---\n\n**Sources:**\n\n- [title](url)`.
- Files: images `![name](https://claude.ai{preview_url})`, other files
  `> File: name`, text pastes in a fence longer than any backtick run inside.
- Collapse 3+ blank lines outside code fences to 2.

## JSON

`{ metadata: {title, created, updated, exported, link}, messages: [{role, time, markdown}] }`

## PDF

Render the Markdown to HTML in an extension page (own print CSS), open it in a
new tab and call `window.print()`; the user picks "Save as PDF". The print page
asks the claude.ai tab's content script for the Markdown (`chrome.tabs.sendMessage`),
so no `storage` permission is needed. Raw HTML in the Markdown is escaped and
only http(s)/mailto links are kept.

Images are embedded as `data:` URLs: the request carries `inlineImages: true`,
the content script (same origin, cookies) fetches every image of the chat and
replaces its URL before rendering. The print page therefore does not depend on
claude.ai cookies in the extension page. It fetches the downscaled `/preview`
(webp) rather than the original, which is plenty for print and keeps the
message small. An image that cannot be fetched keeps its claude.ai URL.
Markdown and JSON exports are unchanged (the Markdown links to claude.ai).

## Saving

All downloads (md, json, zip) go the same way, since a blob URL of the claude.ai
page is unreadable for the download manager and `data:` URLs over ~2 MB fail.
The sender (popup for text, content script for the zip) uploads the bytes as
base64 chunks (6 MiB raw, 8 MiB per message) with `runtime.sendMessage` to an
offscreen document (permission `offscreen`, reason `BLOBS`, created on demand by
the background worker). The background worker asks it to join the chunks into a
Blob URL in the extension origin and calls
`chrome.downloads.download({saveAs: true, conflictAction: 'uniquify'})`. Nothing
the download needs lives in the popup, which may close while Save As is open.
The blob URL is revoked when `downloads.onChanged` reports complete or
interrupted (the item's own `url` identifies it, so the worker keeps no state);
the offscreen document is closed when it holds nothing more.
Filename `YYYY-MM-DD {title}.md|.json`, date = conversation `created_at`,
title sanitised for the filesystem.

## Files (zip)

Fourth popup button, "Download files (N)" (Swedish: "Ladda ner filer (N)"). N is counted when the popup opens
(the content script loads the conversation and lists the files); the button is
disabled when N is 0. Markdown, JSON and PDF are not affected.

Included:
- Files the user uploaded: chat `files_v2` / `files` on human messages (images,
  PDFs, documents, other blobs; `file_kind` `image`, `document`, `blob`) and
  Cowork `payload.file_attachments`.
- Files Claude shared: `files` on assistant messages (that is where
  `SendUserFile` results land in chats; `file_kind: "blob"`), `present_files`
  tool calls in normal chats and `SendUserFile` results
  (`toolUseResult.attachments[]` = `{path, file_uuid}`) in Cowork.
- Duplicates by file id are dropped. A `present_files` path whose basename equals
  a listed file's name is dropped as well (it is the same file).

Excluded: tool screenshots (`{type:'image'}` nested in tool results), artifacts,
pasted text and attachments with `extracted_content`.

Source order (verified live, see below):
1. `GET /api/organizations/{org}/files/{file_uuid}/contents`: the original bytes.
2. Images only, fallback: `preview_url` (`/api/{org}/files/{uuid}/preview`). It is a
   downscaled **webp**, so the entry's extension becomes `.webp`.
3. `present_files`: `GET /api/organizations/{org}/conversations/{conv}/wiggle/download-file?path=…`.
   (Not verified against a real file, see below.)

Live findings (private account, GET only):
- `/contents` returns the original: byte count equals the listed `size_bytes`
  for PNG, PDF, CSV, zip and Claude-made files, and the PDF/PNG/JPEG magic bytes
  are intact. Works for chat uploads and for a Cowork upload id. There is no
  `Content-Type` header, only `Content-Disposition` (and its name can differ
  from `file_name`, e.g. `<timestamp>_image.png`), so `file_name` from the API
  is used.
- `/preview` is `image/webp`, e.g. 1353x896 at 46 kB against a 339 kB PNG.
- Documents (PDF) have no `preview_url` (only `document_asset.url`
  `/api/{org}/files/{uuid}/document_pdf`, which is the same PDF); `/contents`
  covers them.
- The chat API (with the query above) returns legacy `files`, not `files_v2`;
  both are handled, `files_v2` first.
- Missing files answer 404 JSON (`not_found_error`).

Fetching happens in the content script (same origin, cookies), three files at
a time, as `Uint8Array`. The zip (fflate `zipSync`) is built there too; images,
PDFs and other already compressed formats are stored (level 0), the rest is
deflated. The popup gets
a handle: the content script uploads the zip in chunks to the offscreen
document (see Saving) and the background worker downloads it from there.
Progress (`n of N`) goes to the popup with `runtime.sendMessage`. The whole zip
is held in memory, which is fine for a chat's
worth of files (a 12 MB case is covered by a test) but not for gigabytes.

Naming:
- Zip: `YYYY-MM-DD Title – files.zip` (`… – filer.zip` in Swedish), same date and sanitising as the `.md` name.
- Entries: original file names (path separators and characters illegal on
  Windows become `_`). A name that is already taken (case-insensitively) becomes
  `name (2).ext`, `name (3).ext`, …
- Entry dates: the file's `created_at` (chat `files`/`files_v2`), the upload
  event's time (Cowork) or the message time (files Claude shared), stored as
  local time. Unknown or pre-1980 dates fall back to the export time.

Failures: the zip is still made from what worked. The popup then says
"X of N files could not be fetched" and the zip contains `missing.txt`
(`saknas.txt` in Swedish) with one line per missing file and a short reason (not
found, no access, rate limited, network error, unknown error). If every file fails, the popup shows an error and
nothing is saved.

## Localisation

Interface texts use Chrome's `_locales` mechanism: `public/_locales/en/messages.json`
(default, `"default_locale": "en"`) and `public/_locales/sv/messages.json`. The
browser picks the locale from its UI language; any other language gets English.
The manifest `name` and `description` use `__MSG_…__`. Vite copies `public/` into
`dist/`, which includes `_locales/`.

- Localised: popup labels, status and error texts, the print page, the zip file
  name suffix, the missing-files list (name, heading, reasons) and `<html lang>`
  of the extension pages (from `chrome.i18n.getUILanguage()`).
- Not localised, always English: Markdown headings and labels (`## User:`,
  `**Created:**`, `**Done**`), JSON keys, `.md` / `.json` file names and the date format.
- `src/core` stays free of `chrome.*`. Texts that end up in its output are
  passed in as a `ZipTexts` object (defaults English); `src/extension/i18n.ts`
  builds it with `chrome.i18n.getMessage`. Placeholders (`$1`…) are used where
  counts or names appear.
- `tests/locales.test.ts` checks that both locales have the same keys and
  placeholders and that every key used in `src/` and `public/` exists.
