// Isolated-world content script on claude.ai. Loads and renders the open
// conversation on request from the popup or the print page. All requests go to
// claude.ai itself (same origin, the user's cookies).

import { ExportError, emptyHookState, exportConversation, fetchHttp, listFiles, zipFiles, type HookState, type LoadContext } from '../core';
import {
  CS_SOURCE,
  errorText,
  HOOK_SOURCE,
  type ExportRequest,
  type ExportResponse,
  type FilesProgress,
  type FilesRequest,
  type FilesResponse,
  type HookMessage,
} from './messages';
import { t, zipTexts } from './i18n';
import { uploadBytes } from './upload';

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Ask the MAIN-world hook what it has seen. Empty state if it does not answer. */
function hookState(timeoutMs = 500): Promise<HookState> {
  const nonce = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (s: HookState) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(s);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const data = e.data as HookMessage | undefined;
      if (data?.source === HOOK_SOURCE && data.type === 'state' && data.nonce === nonce) done(data.state);
    };
    const timer = setTimeout(() => done(emptyHookState()), timeoutMs);
    window.addEventListener('message', onMessage);
    const msg: HookMessage = { source: CS_SOURCE, type: 'get-state', nonce };
    window.postMessage(msg, location.origin);
  });
}

const http = () => fetchHttp(window.fetch.bind(window));

async function loadContext(): Promise<LoadContext> {
  const hook = await hookState();
  const titleHint = document.title.replace(/\s+-\s+Claude$/, '').trim() || null;
  return { href: location.href, orgCookie: readCookie('lastActiveOrg'), hook, titleHint };
}

function failure(e: unknown): { ok: false; code: ExportError['code']; message: string } {
  const code = e instanceof ExportError ? e.code : 'unknown';
  console.warn('[Export for Claude]', e);
  return { ok: false, code, message: errorText(code) };
}

async function handle(req: ExportRequest): Promise<ExportResponse> {
  try {
    const result = await exportConversation(http(), await loadContext(), req.format, new Date(), {
      inlineImages: req.inlineImages,
    });
    return { ok: true, ...result };
  } catch (e) {
    return failure(e);
  }
}

async function handleFiles(req: FilesRequest): Promise<FilesResponse> {
  try {
    const ctx = await loadContext();
    if (req.action === 'count') {
      return { ok: true, action: 'count', count: (await listFiles(http(), ctx, zipTexts())).files.length };
    }
    const progress = (done: number, total: number) => {
      const msg: FilesProgress = { type: 'export-for-claude:files-progress', done, total };
      chrome.runtime.sendMessage(msg).catch(() => {}); // the popup may be closed
    };
    const zip = await zipFiles(http(), ctx, progress, zipTexts());
    if (!zip.bytes) {
      const message = zip.total ? t('errorNoFilesFetched') : t('errorNoFiles');
      return { ok: false, code: 'no_files', message };
    }
    // The zip goes to the offscreen document in chunks; the popup only gets a handle.
    const upload = await uploadBytes(zip.bytes, 'application/zip');
    return { ok: true, action: 'zip', filename: zip.zipFilename, upload, total: zip.total, missing: zip.missing };
  } catch (e) {
    return failure(e);
  }
}

chrome.runtime.onMessage.addListener((msg: ExportRequest | FilesRequest, _sender, sendResponse) => {
  if (msg?.type === 'export-for-claude:export') {
    handle(msg).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'export-for-claude:files') {
    handleFiles(msg).then(sendResponse);
    return true;
  }
  return false;
});
