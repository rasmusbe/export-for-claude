// Service worker: saves exports with chrome.downloads. Done here rather than in
// the popup because the popup may close while the Save As dialog is open.
//
// The bytes live in an offscreen document (reason BLOBS). It makes a Blob URL in
// the extension origin, which the download manager can read (a blob URL owned by
// the claude.ai page is not readable, and data: URLs over ~2 MB fail). The URL is
// revoked once the download has completed or been interrupted/cancelled.

import { t } from './i18n';
import type {
  BlobFinishMessage,
  BlobFinishResponse,
  BlobRevokeMessage,
  BlobRevokeResponse,
  DownloadRequest,
  DownloadResponse,
  OffscreenEnsureMessage,
  OkResponse,
} from './messages';

const OFFSCREEN_URL = 'offscreen.html';
const BLOB_PREFIX = `blob:chrome-extension://${chrome.runtime.id}/`;

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

/** Create the offscreen document if it is not there. Concurrent callers share one creation. */
async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Make Blob URLs in the extension origin for chrome.downloads.',
      })
      .catch((e: Error) => {
        // Another creation won the race: that is fine.
        if (!/single offscreen|already exists/i.test(e.message)) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function revoke(url: string): Promise<void> {
  if (!(await hasOffscreen())) return;
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'export-for-claude:blob-revoke', url } satisfies BlobRevokeMessage)) as
      | BlobRevokeResponse
      | undefined;
    if (res?.ok && res.idle) await chrome.offscreen.closeDocument();
  } catch {
    // The document went away on its own; its URLs went with it.
  }
}

async function download(msg: DownloadRequest): Promise<DownloadResponse> {
  await ensureOffscreen();
  const made = (await chrome.runtime.sendMessage({
    type: 'export-for-claude:blob-finish',
    uploadId: msg.uploadId,
    count: msg.count,
    mime: msg.mime,
  } satisfies BlobFinishMessage)) as BlobFinishResponse | undefined;
  if (!made?.ok) return { ok: false, message: made?.message ?? t('errorNoBackground') };
  try {
    await chrome.downloads.download({ url: made.url, filename: msg.filename, saveAs: true, conflictAction: 'uniquify' });
    return { ok: true };
  } catch (e) {
    await revoke(made.url);
    return { ok: false, message: (e as Error).message };
  }
}

chrome.runtime.onMessage.addListener((msg: DownloadRequest | OffscreenEnsureMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'export-for-claude:offscreen-ensure') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true } satisfies OkResponse))
      .catch((e: Error) => sendResponse({ ok: false, message: e.message } satisfies OkResponse));
    return true;
  }
  if (msg?.type === 'export-for-claude:download') {
    download(msg).then(sendResponse, (e: Error) => sendResponse({ ok: false, message: e.message } satisfies DownloadResponse));
    return true;
  }
  return false;
});

// Registered at top level so a sleeping worker wakes for it. Stateless: the
// finished item carries its own blob URL.
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  void chrome.downloads.search({ id: delta.id }).then(async ([item]) => {
    if (item?.url.startsWith(BLOB_PREFIX)) await revoke(item.url);
  });
});
