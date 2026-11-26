// Load the open conversation through claude.ai's own API.

import { ExportError, type Http } from './api';
import { normaliseChat } from './chat';
import { normaliseCowork, sortEvents, type CoworkEvent } from './cowork';
import { isUuidV8, parsePage } from './page';
import type { Conversation, Json } from './types';

/** What the MAIN-world hook has seen on the page. */
export interface HookState {
  incognito: { orgId: string; convoId: string } | null;
  /** Session ids from the page's own `GET /v1/code/sessions/{cse}` requests. */
  sessionCandidates: { sessionId: string; chatId: string | null; at: number }[];
  /** chat uuid → session id, from ReadCoworkSession traffic. */
  confirmed: Record<string, string>;
}

export const emptyHookState = (): HookState => ({ incognito: null, sessionCandidates: [], confirmed: {} });

export interface LoadContext {
  href: string;
  /** `lastActiveOrg` cookie, if any. */
  orgCookie: string | null;
  hook: HookState;
  /** Page title without the " - Claude" suffix, used to rank Cowork sessions. */
  titleHint?: string | null;
}

const CHAT_QUERY = 'tree=True&rendering_mode=messages&render_all_tools=true';
const SESSION_LIST_PAGES = 10;
const RPC_VERIFY_CAP = 300;
const EVENT_PAGES_CAP = 200;

export const READ_COWORK_SESSION = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadCoworkSession';

export function coworkHeaders(orgId: string): Record<string, string> {
  return { 'anthropic-version': '2023-06-01', 'x-organization-uuid': orgId };
}

/** Candidate org ids: the cookie first, then chat-capable orgs from the API. */
async function orgCandidates(http: Http, cookie: string | null): Promise<string[]> {
  const ids: string[] = cookie ? [cookie] : [];
  try {
    const orgs = (await http.getJson('/api/organizations')) as Json[];
    for (const o of Array.isArray(orgs) ? orgs : []) {
      const caps: string[] = Array.isArray(o?.capabilities) ? o.capabilities : [];
      if (o?.uuid && caps.includes('chat') && !ids.includes(o.uuid)) ids.push(o.uuid);
    }
  } catch (e) {
    if (!ids.length) throw e;
  }
  if (!ids.length) throw new ExportError('not_logged_in', 'No organization found');
  return ids;
}

/** Try `fn` with each org until one does not answer 401/403/404. */
async function withOrgs<T>(
  http: Http,
  cookie: string | null,
  fn: (orgId: string) => Promise<T>,
): Promise<{ orgId: string; value: T }> {
  const tried: string[] = [];
  let lastErr: unknown = null;
  const attempt = async (ids: string[]) => {
    for (const orgId of ids) {
      if (tried.includes(orgId)) continue;
      tried.push(orgId);
      try {
        return { orgId, value: await fn(orgId) };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ExportError) || !['not_found', 'not_logged_in'].includes(e.code)) throw e;
      }
    }
    return null;
  };
  // Cheap path: the cookie alone, without listing organisations.
  if (cookie) {
    const r = await attempt([cookie]);
    if (r) return r;
  }
  const r = await attempt(await orgCandidates(http, cookie));
  if (r) return r;
  throw lastErr ?? new ExportError('not_found', 'Conversation not found');
}

export async function loadConversation(http: Http, ctx: LoadContext): Promise<Conversation> {
  const page = parsePage(ctx.href);
  const linkFor = (id: string) => `https://claude.ai/chat/${id}`;

  if (page.kind === 'share') {
    const data = await http.getJson(`/api/chat_snapshots/${page.id}?rendering_mode=messages&render_all_tools=true`);
    return normaliseChat(data?.snapshot ?? data, { link: ctx.href, orgId: null, conversationId: null });
  }

  if (page.kind === 'new') {
    const inc = ctx.hook.incognito;
    if (!inc) throw new ExportError('not_a_chat', 'No conversation on this page yet');
    const data = await http.getJson(`/api/organizations/${inc.orgId}/chat_conversations/${inc.convoId}?${CHAT_QUERY}`);
    return normaliseChat(data, { link: ctx.href, orgId: inc.orgId, conversationId: inc.convoId });
  }

  if (page.kind !== 'chat') throw new ExportError('not_a_chat', 'Not a claude.ai conversation');
  const chatId = page.id;

  if (!isUuidV8(chatId)) {
    try {
      const { orgId, value } = await withOrgs(http, ctx.orgCookie, (org) =>
        http.getJson(`/api/organizations/${org}/chat_conversations/${chatId}?${CHAT_QUERY}`),
      );
      return normaliseChat(value, { link: linkFor(chatId), orgId, conversationId: chatId });
    } catch (e) {
      if (!(e instanceof ExportError) || e.code !== 'not_found') throw e;
      // Fall through: a Cowork chat that does not use a v8 id.
    }
  }

  const { orgId, value: sessionId } = await withOrgs(http, ctx.orgCookie, async (org) => {
    // Listing every session is only worth it for ids that are Cowork by shape.
    const id = await resolveSessionId(http, org, chatId, ctx.hook, ctx.titleHint ?? null, isUuidV8(chatId));
    if (!id) throw new ExportError('not_found', `No Cowork session for chat ${chatId}`);
    return id;
  });
  const headers = coworkHeaders(orgId);
  const [session, events] = await Promise.all([
    http.getJson(`/v1/code/sessions/${sessionId}`, headers),
    fetchAllEvents(http, sessionId, headers),
  ]);
  return normaliseCowork(session, events, { link: linkFor(chatId), orgId, conversationId: chatId });
}

/**
 * All events of a session. The API returns newest first, 500 per page, with
 * `next_cursor` pointing at older events until it is null.
 */
export async function fetchAllEvents(http: Http, sessionId: string, headers: Record<string, string>): Promise<CoworkEvent[]> {
  const all: CoworkEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < EVENT_PAGES_CAP; page++) {
    const path: string =
      `/v1/code/sessions/${sessionId}/events?limit=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res: Json = await http.getJson(path, headers);
    const data = Array.isArray(res?.data) ? res.data : [];
    all.push(...data);
    const next: string | null = res?.next_cursor ?? null;
    if (!next || next === cursor || !data.length) break;
    cursor = next;
  }
  return sortEvents(all);
}

/** Ask the server which chat a session belongs to. Null when the RPC fails. */
export async function chatIdForSession(http: Http, orgId: string, sessionId: string): Promise<string | null> {
  try {
    const res = await http.postJson(
      READ_COWORK_SESSION,
      { sessionId, limit: 1, metaOnly: true },
      { 'connect-protocol-version': '1', 'anthropic-client-platform': 'web_claude_ai', 'x-organization-uuid': orgId },
    );
    const id = res?.continuation?.conversationId;
    return typeof id === 'string' ? id.toLowerCase() : null;
  } catch (e) {
    if (e instanceof ExportError && e.code === 'rate_limited') throw e;
    return null;
  }
}

/**
 * Map a chat uuid to its Cowork session id.
 *
 * 1. A mapping the hook saw in ReadCoworkSession traffic.
 * 2. Session ids the page itself requested (the page loads the session of the
 *    open chat), verified with ReadCoworkSession. If verification is not
 *    possible and exactly one candidate was seen for this chat, use it.
 * 3. List the user's Cowork sessions (title matches first) and verify each.
 */
export async function resolveSessionId(
  http: Http,
  orgId: string,
  chatId: string,
  hook: HookState,
  titleHint: string | null,
  allowListing = true,
): Promise<string | null> {
  const confirmed = hook.confirmed[chatId];
  if (confirmed) return confirmed;

  const checked = new Set<string>();
  let rpcWorks = false;
  let rpcCalls = 0;
  const verify = async (sessionId: string): Promise<boolean> => {
    if (checked.has(sessionId)) return false;
    checked.add(sessionId);
    rpcCalls++;
    const id = await chatIdForSession(http, orgId, sessionId);
    if (id) rpcWorks = true;
    return id === chatId;
  };

  const sniffed = [...hook.sessionCandidates].sort((a, b) => b.at - a.at);
  const forThisChat = sniffed.filter((c) => c.chatId === chatId);
  const ordered = [...forThisChat, ...sniffed.filter((c) => c.chatId !== chatId)].map((c) => c.sessionId);
  for (const id of [...new Set(ordered)].slice(0, 8)) {
    if (await verify(id)) return id;
  }
  const uniqueForChat = [...new Set(forThisChat.map((c) => c.sessionId))];
  if (!rpcWorks && uniqueForChat.length === 1) return uniqueForChat[0];
  if (!allowListing) return null;

  const headers = coworkHeaders(orgId);
  const rest: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SESSION_LIST_PAGES; page++) {
    const path: string =
      '/v1/code/sessions?limit=100&tags=cowork-remote&include_trigger_sessions=true' +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res: Json = await http.getJson(path, headers);
    const items: Json[] = Array.isArray(res?.data) ? res.data : [];
    for (const s of items) {
      if (!s?.id) continue;
      if (titleHint && s.title === titleHint) {
        if (await verify(s.id)) return s.id;
      } else {
        rest.push(s.id);
      }
    }
    cursor = res?.next_cursor ?? null;
    if (!cursor || !items.length) break;
  }
  for (const id of rest) {
    if (rpcCalls >= RPC_VERIFY_CAP) break;
    if (!rpcWorks && rpcCalls >= 3) break; // RPC unavailable: stop early
    if (await verify(id)) return id;
  }
  return null;
}
