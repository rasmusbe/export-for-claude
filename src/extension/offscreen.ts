// Offscreen document (reason BLOBS). It owns the bytes of an export until the
// download is over: it reassembles the chunks, makes a Blob URL in the extension
// origin (which the download manager can read) and revokes it when told to.
// Nothing here depends on the popup, which may close while Save As is open.

import { BlobAssembler } from './blobs';
import { localisePage, t } from './i18n';
import type {
  BlobChunkMessage,
  BlobFinishMessage,
  BlobFinishResponse,
  BlobRevokeMessage,
  BlobRevokeResponse,
  OkResponse,
} from './messages';

const STALE_MS = 10 * 60 * 1000;
const uploads = new Map<string, { assembler: BlobAssembler; touched: number }>();
const urls = new Set<string>();

function dropStale() {
  const now = Date.now();
  for (const [id, u] of uploads) if (now - u.touched > STALE_MS) uploads.delete(id);
}

type Msg = BlobChunkMessage | BlobFinishMessage | BlobRevokeMessage;

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg?.type) {
    case 'export-for-claude:blob-chunk': {
      dropStale();
      try {
        let u = uploads.get(msg.uploadId);
        if (!u) uploads.set(msg.uploadId, (u = { assembler: new BlobAssembler(), touched: 0 }));
        u.touched = Date.now();
        u.assembler.add(msg.index, msg.data);
        sendResponse({ ok: true } satisfies OkResponse);
      } catch (e) {
        sendResponse({ ok: false, message: (e as Error).message } satisfies OkResponse);
      }
      return false;
    }
    case 'export-for-claude:blob-finish': {
      const u = uploads.get(msg.uploadId);
      try {
        if (!u) throw new Error(t('errorFileGone'));
        const parts = u.assembler.finish(msg.count);
        uploads.delete(msg.uploadId);
        const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: msg.mime }));
        urls.add(url);
        sendResponse({ ok: true, url } satisfies BlobFinishResponse);
      } catch (e) {
        sendResponse({ ok: false, message: (e as Error).message } satisfies BlobFinishResponse);
      }
      return false;
    }
    case 'export-for-claude:blob-revoke': {
      URL.revokeObjectURL(msg.url);
      urls.delete(msg.url);
      dropStale();
      sendResponse({ ok: true, idle: urls.size === 0 && uploads.size === 0 } satisfies BlobRevokeResponse);
      return false;
    }
    default:
      return false;
  }
});

localisePage();
