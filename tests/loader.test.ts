import { describe, expect, it } from 'vitest';
import { ExportError, type Http } from '../src/core/api';
import { buildJson } from '../src/core/json';
import { emptyHookState, fetchAllEvents, loadConversation, READ_COWORK_SESSION } from '../src/core/loader';
import { renderMarkdown } from '../src/core/markdown';
import { loadPrivate } from './helpers';

type Route = (path: string, body?: any, headers?: Record<string, string>) => any;

/** Fake Http: routes match on path prefix; a number result is an HTTP error. */
function fakeHttp(routes: [string | RegExp, Route][], log: string[] = []): Http {
  const handle = (path: string, body?: any, headers?: Record<string, string>) => {
    log.push(path);
    for (const [m, fn] of routes) {
      if (typeof m === 'string' ? path.startsWith(m) : m.test(path)) {
        const r = fn(path, body, headers);
        if (typeof r === 'number') {
          const code = r === 404 ? 'not_found' : r === 403 ? 'not_logged_in' : r === 429 ? 'rate_limited' : 'unknown';
          return Promise.reject(new ExportError(code, String(r), r));
        }
        return Promise.resolve(r);
      }
    }
    return Promise.reject(new ExportError('not_found', `no route ${path}`, 404));
  };
  return {
    getJson: (p, h) => handle(p, undefined, h),
    postJson: (p, b, h) => handle(p, b, h),
    getBytes: () => Promise.reject(new ExportError('not_found', 'no bytes', 404)),
  };
}

const CHAT = '3f2a9c1e-5b7d-8e4f-9a1b-2c3d4e5f6a7b';
const ORG = 'org-1';

const event = (seq: number, extra: any = {}) => ({
  event_id: `e${seq}`,
  sequence_num: String(seq),
  source: 'worker',
  event_type: 'assistant',
  created_at: `2026-01-01T10:00:${String(seq).padStart(2, '0')}Z`,
  payload: { message: { content: [{ type: 'text', text: `t${seq}` }] } },
  ...extra,
});

describe('Cowork events', () => {
  it('pages with next_cursor until null and sorts by sequence', async () => {
    const http = fakeHttp([
      [/events\?limit=500&cursor=25/, () => ({ data: [event(2), event(1)], next_cursor: null, resume_cursor: '1' })],
      [/events\?limit=500$/, () => ({ data: [event(4), event(3)], next_cursor: '25', resume_cursor: '25' })],
    ]);
    const evs = await fetchAllEvents(http, 'cse_1', {});
    expect(evs.map((e) => e.sequence_num)).toEqual(['1', '2', '3', '4']);
  });
});

describe('Cowork session mapping', () => {
  const sessionRoutes = (log: string[] = []): [string | RegExp, Route][] => [
    ['/v1/code/sessions/cse_right/events', () => ({ data: [event(1)], next_cursor: null })],
    ['/v1/code/sessions/cse_right', (_p, _b, h) => {
      log.push(`headers:${h?.['x-organization-uuid']}:${h?.['anthropic-version']}`);
      return { response_shape: { title: 'Weather check', created_at: '2026-01-01T09:00:00Z', last_event_at: '2026-01-01T10:00:00Z' } };
    }],
    [READ_COWORK_SESSION, (_p, body) => ({ continuation: { conversationId: body.sessionId === 'cse_right' ? CHAT : 'other' } })],
    ['/v1/code/sessions?', (p) =>
      p.includes('cursor=c2')
        ? { data: [{ id: 'cse_right', title: 'Weather check' }], next_cursor: null }
        : { data: [{ id: 'cse_a', title: 'Other' }, { id: 'cse_b', title: 'Weather check' }], next_cursor: 'c2' }],
  ];

  it('uses a session id sniffed from the page, verified by ReadCoworkSession', async () => {
    const log: string[] = [];
    const hook = emptyHookState();
    hook.sessionCandidates.push({ sessionId: 'cse_other', chatId: null, at: 1 }, { sessionId: 'cse_right', chatId: CHAT, at: 2 });
    const conv = await loadConversation(fakeHttp(sessionRoutes(log), log), {
      href: `https://claude.ai/chat/${CHAT}`,
      orgCookie: ORG,
      hook,
    });
    expect(conv.kind).toBe('cowork');
    expect(conv.title).toBe('Weather check');
    expect(conv.link).toBe(`https://claude.ai/chat/${CHAT}`);
    expect(log).toContain(`headers:${ORG}:2023-06-01`);
    expect(log.some((p) => p.startsWith('/v1/code/sessions?'))).toBe(false);
    expect(log.some((p) => p.startsWith('/api/organizations/'))).toBe(false); // v8 id: no chat endpoint call
  });

  it('falls back to listing sessions, title matches first', async () => {
    const log: string[] = [];
    const conv = await loadConversation(fakeHttp(sessionRoutes(), log), {
      href: `https://claude.ai/chat/${CHAT}`,
      orgCookie: ORG,
      hook: emptyHookState(),
      titleHint: 'Weather check',
    });
    expect(conv.messages).toHaveLength(1);
    // cse_b (title match) is checked before cse_a; cse_a is never needed.
    const rpcs = log.filter((p) => p === READ_COWORK_SESSION).length;
    expect(rpcs).toBe(2);
  });

  it('uses a confirmed mapping without any lookups', async () => {
    const log: string[] = [];
    const hook = emptyHookState();
    hook.confirmed[CHAT] = 'cse_right';
    await loadConversation(fakeHttp(sessionRoutes(), log), { href: `https://claude.ai/chat/${CHAT}`, orgCookie: ORG, hook });
    expect(log.filter((p) => p === READ_COWORK_SESSION)).toHaveLength(0);
  });
});

describe('chat loading', () => {
  const V4 = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
  const chat = { name: 'Chat', created_at: '2026-01-01T09:00:00Z', chat_messages: [{ uuid: 'm', sender: 'human', content: [{ type: 'text', text: 'hi' }] }] };

  it('falls back from the cookie org to /api/organizations', async () => {
    const log: string[] = [];
    const http = fakeHttp(
      [
        ['/api/organizations/stale/', () => 403],
        ['/api/organizations/good/chat_conversations/', () => chat],
        ['/api/organizations', () => [{ uuid: 'api-only', capabilities: ['api'] }, { uuid: 'good', capabilities: ['chat'] }]],
      ],
      log,
    );
    const conv = await loadConversation(http, { href: `https://claude.ai/chat/${V4}`, orgCookie: 'stale', hook: emptyHookState() });
    expect(conv.orgId).toBe('good');
    expect(conv.title).toBe('Chat');
  });

  it('reports not logged in, rate limits and non-chat pages', async () => {
    const forbidden = fakeHttp([['/api/organizations', () => 403]]);
    await expect(loadConversation(forbidden, { href: `https://claude.ai/chat/${V4}`, orgCookie: 'o', hook: emptyHookState() })).rejects.toMatchObject({ code: 'not_logged_in' });
    const limited = fakeHttp([['/api/organizations/o/', () => 429]]);
    await expect(loadConversation(limited, { href: `https://claude.ai/chat/${V4}`, orgCookie: 'o', hook: emptyHookState() })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(loadConversation(limited, { href: 'https://claude.ai/projects', orgCookie: 'o', hook: emptyHookState() })).rejects.toMatchObject({ code: 'not_a_chat' });
    await expect(loadConversation(limited, { href: 'https://claude.ai/new', orgCookie: 'o', hook: emptyHookState() })).rejects.toMatchObject({ code: 'not_a_chat' });
  });

  it('loads an incognito chat from the id the hook saw', async () => {
    const hook = emptyHookState();
    hook.incognito = { orgId: 'o', convoId: V4 };
    const http = fakeHttp([[`/api/organizations/o/chat_conversations/${V4}?`, () => chat]]);
    const conv = await loadConversation(http, { href: 'https://claude.ai/new?incognito', orgCookie: null, hook });
    expect(conv.messages).toHaveLength(1);
  });

  it('loads a shared chat snapshot', async () => {
    const http = fakeHttp([[`/api/chat_snapshots/${V4}?`, () => ({ ...chat, name: undefined, snapshot_name: 'Delad' })]]);
    const conv = await loadConversation(http, { href: `https://claude.ai/share/${V4}`, orgCookie: null, hook: emptyHookState() });
    expect(conv.title).toBe('Delad');
  });
});

const privateFx = loadPrivate('private-fixtures.json');

describe.skipIf(!privateFx)('private fixtures (smoke)', () => {
  it('renders every normal chat and the 34-event Cowork session', async () => {
    for (const c of privateFx.normalChats) {
      const data = c.data ?? c;
      const http = fakeHttp([['/api/organizations/', () => data]]);
      const conv = await loadConversation(http, { href: `https://claude.ai/chat/${data.uuid}`, orgCookie: privateFx.org, hook: emptyHookState() });
      const md = renderMarkdown(conv);
      expect(md.startsWith(`# ${data.name}\n`)).toBe(true);
      expect(md).not.toMatch(/\n\n\n/);
      expect(buildJson(conv).messages.length).toBe(conv.messages.length);
    }
    const sid: string = privateFx.session.response_shape?.id ?? 'cse_fixture';
    const hook = emptyHookState();
    hook.confirmed[CHAT] = sid;
    const http = fakeHttp([
      [`/v1/code/sessions/${sid}/events`, () => ({ data: privateFx.events, next_cursor: null })],
      [`/v1/code/sessions/${sid}`, () => privateFx.session],
    ]);
    const conv = await loadConversation(http, { href: `https://claude.ai/chat/${CHAT}`, orgCookie: privateFx.org, hook });
    const md = renderMarkdown(conv);
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(md).not.toContain('<system-reminder>');
    const last = conv.messages[1].blocks.filter((b) => b.type === 'text');
    expect(last.length).toBeGreaterThan(0);
    expect(md.trimEnd().endsWith((last[last.length - 1] as { text: string }).text.trim())).toBe(true);
  });
});
