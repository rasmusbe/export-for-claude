// MAIN-world script, injected at document_start on claude.ai.
//
// It watches the page's own fetch traffic for ids the content script cannot
// read from the URL:
// - incognito chats: the completion POST carries org and conversation id;
// - Cowork chats: the page loads `GET /v1/code/sessions/{cse}` for the open
//   chat, and ReadCoworkSession answers map a session to its chat uuid.
// It never changes requests or responses. The content script asks for the
// collected state with window.postMessage.

import { HOOK_SOURCE, CS_SOURCE, type HookMessage } from './messages';
import type { HookState } from '../core/loader';

(() => {
  const w = window as unknown as { __exportForClaudeHook?: boolean };
  if (w.__exportForClaudeHook) return;
  w.__exportForClaudeHook = true;

  const state: HookState = { incognito: null, sessionCandidates: [], confirmed: {} };
  const COMPLETION_RE = /^\/api\/organizations\/([0-9a-f-]{36})\/chat_conversations\/([0-9a-f-]{36})\/completion$/i;
  const SESSION_RE = /^\/v1\/code\/sessions\/(cse_[A-Za-z0-9]+)$/;
  const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const CSE_G = /cse_[A-Za-z0-9]{10,}/g;

  const currentChatId = (): string | null => {
    const m = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  };

  let lastPath = location.pathname;
  const onRoute = () => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    state.incognito = null;
  };
  for (const key of ['pushState', 'replaceState'] as const) {
    const orig = history[key];
    history[key] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args);
      try {
        onRoute();
      } catch {
        /* never break the page */
      }
      return r;
    } as History['pushState'];
  }
  window.addEventListener('popstate', onRoute);

  /** Request bodies and responses may be JSON or protobuf; scan both as text. */
  const bytesToText = (buf: ArrayBuffer | Uint8Array): string => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
    return s;
  };
  const bodyText = (body: unknown): string | null => {
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) return bytesToText(body);
    if (ArrayBuffer.isView(body)) return bytesToText(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return null;
  };

  const origFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const promise = origFetch.call(this ?? window, input, init);
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin === location.origin) {
        const path = url.pathname;
        const completion = method === 'POST' && path.match(COMPLETION_RE);
        if (completion) {
          state.incognito = { orgId: completion[1].toLowerCase(), convoId: completion[2].toLowerCase() };
        }
        const session = method === 'GET' && path.match(SESSION_RE);
        if (session) {
          state.sessionCandidates.push({ sessionId: session[1], chatId: currentChatId(), at: Date.now() });
          if (state.sessionCandidates.length > 50) state.sessionCandidates.shift();
        }
        if (method === 'POST' && path.endsWith('/ReadCoworkSession')) {
          const req = bodyText(init?.body);
          const sessions = req ? [...new Set(req.match(CSE_G) ?? [])] : [];
          if (sessions.length === 1) {
            promise
              .then((res) => res.clone().arrayBuffer())
              .then((buf) => {
                const chats = [...new Set(bytesToText(buf).match(UUID_G) ?? [])];
                if (chats.length === 1) state.confirmed[chats[0].toLowerCase()] = sessions[0];
              })
              .catch(() => {});
          }
        }
      }
    } catch {
      /* never break the page */
    }
    return promise;
  } as typeof fetch;

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data as HookMessage | undefined;
    if (data?.source !== CS_SOURCE || data.type !== 'get-state') return;
    const reply: HookMessage = { source: HOOK_SOURCE, type: 'state', nonce: data.nonce, state };
    window.postMessage(reply, location.origin);
  });
})();
