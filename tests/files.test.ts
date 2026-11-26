import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ExportError, type Http } from '../src/core/api';
import { normaliseChat } from '../src/core/chat';
import { coworkMessages } from '../src/core/cowork';
import { collectFiles } from '../src/core/files';
import { buildZipFilename } from '../src/core/format';
import { embedImages } from '../src/core/images';
import { renderMarkdown } from '../src/core/markdown';
import type { Conversation } from '../src/core/types';
import { buildFilesZip, safeEntryName, uniqueName, zipDate, type ZipTexts } from '../src/core/zip';
import { DEFAULT_ZIP_TEXTS, listFiles } from '../src/core';
import { emptyHookState } from '../src/core/loader';
import { loadPrivate } from './helpers';

const ORG = 'org-1';
const CONV = 'conv-1';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';

const contents = (u: string) => `/api/organizations/${ORG}/files/${u}/contents`;
const preview = (u: string) => `/api/${ORG}/files/${u}/preview`;

type Handler = (path: string) => Uint8Array | number | Error;

/** Fake Http whose getBytes is routed by a function; a number is an HTTP status. */
function bytesHttp(handler: Handler, log: string[] = []): Http {
  const fail = () => Promise.reject(new ExportError('not_found', 'no json', 404));
  return {
    getJson: fail,
    postJson: fail,
    getBytes: async (path) => {
      log.push(path);
      const r = handler(path);
      if (r instanceof Uint8Array) return r;
      if (r instanceof Error) throw r;
      throw new ExportError(r === 404 ? 'not_found' : r === 403 ? 'not_logged_in' : r === 429 ? 'rate_limited' : 'unknown', String(r), r);
    },
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);

const chatMsg = (uuid: string, sender: string, parent: string | null, extra: any = {}) => ({
  uuid,
  sender,
  parent_message_uuid: parent,
  content: [{ type: 'text', text: uuid }],
  updated_at: '2026-01-01T00:00:00Z',
  ...extra,
});

function chat(messages: any[]): Conversation {
  return normaliseChat(
    { name: 'Test', created_at: '2026-03-05T10:00:00Z', chat_messages: messages, current_leaf_message_uuid: messages.at(-1).uuid },
    { link: `https://claude.ai/chat/${CONV}`, orgId: ORG, conversationId: CONV },
  );
}

describe('collectFiles: chats', () => {
  it('collects uploads and files Claude made, with the original first and a preview fallback for images', () => {
    const conv = chat([
      chatMsg('a', 'human', null, {
        files: [
          { file_kind: 'image', file_name: 'image.png', file_uuid: U1, preview_url: preview(U1), created_at: '2026-02-01T10:00:00Z' },
          { file_kind: 'document', file_name: 'report.pdf', file_uuid: U2 },
          { file_kind: 'blob', file_name: 'data.csv', file_uuid: U3 },
        ],
      }),
      chatMsg('b', 'assistant', 'a', { files: [{ file_kind: 'blob', file_name: 'answer.md', file_uuid: U4 }] }),
    ]);
    expect(collectFiles(conv)[0].createdAt).toBe('2026-02-01T10:00:00Z');
    expect(collectFiles(conv)).toMatchObject([
      { name: 'image.png', sources: [{ path: contents(U1) }, { path: preview(U1), ext: 'webp' }] },
      { name: 'report.pdf', sources: [{ path: contents(U2) }] },
      { name: 'data.csv', sources: [{ path: contents(U3) }] },
      { name: 'answer.md', sources: [{ path: contents(U4) }] },
    ]);
  });

  it('prefers files_v2 over files and drops duplicate file ids', () => {
    const f = { file_kind: 'blob', file_name: 'x.txt', file_uuid: U1 };
    const conv = chat([
      chatMsg('a', 'human', null, { files_v2: [f], files: [{ ...f, file_name: 'old.txt', file_uuid: U2 }] }),
      chatMsg('b', 'human', 'a', { files_v2: [f] }),
      chatMsg('c', 'assistant', 'b', { files: [f] }),
    ]);
    expect(collectFiles(conv).map((x) => x.name)).toEqual(['x.txt']);
  });

  it('excludes pasted text, artifacts and tool screenshots', () => {
    const conv = chat([
      chatMsg('a', 'human', null, {
        attachments: [
          { file_name: 'anteckning.md', file_type: 'text/markdown', extracted_content: 'text' },
          { file_name: '', file_type: 'txt', extracted_content: 'klistrat' },
        ],
      }),
      chatMsg('b', 'assistant', 'a', {
        content: [
          { type: 'tool_use', id: 't1', name: 'artifacts', input: { command: 'create', id: 'x', type: 'text/html', content: '<p>hi</p>' } },
          {
            type: 'tool_result',
            tool_use_id: 't1',
            name: 'computer',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
          },
        ],
      }),
    ]);
    expect(collectFiles(conv)).toEqual([]);
  });

  it('skips files without a file id', () => {
    const conv = chat([chatMsg('a', 'human', null, { files: [{ file_kind: 'blob', file_name: 'x.txt' }] })]);
    expect(collectFiles(conv)).toEqual([]);
  });

  it('collects present_files through the wiggle endpoint, unless the file is already listed by id', () => {
    const present = (id: string, paths: string[]) => ({
      type: 'tool_use',
      id,
      name: 'present_files',
      input: { filepaths: paths },
    });
    const conv = chat([
      chatMsg('a', 'human', null),
      chatMsg('b', 'assistant', 'a', {
        content: [present('p1', ['/mnt/user-data/outputs/report.docx', '/mnt/user-data/outputs/copy.txt'])],
        files: [{ file_kind: 'blob', file_name: 'copy.txt', file_uuid: U1 }],
      }),
      chatMsg('c', 'human', 'b'),
      chatMsg('d', 'assistant', 'c', { content: [present('p2', ['/mnt/user-data/outputs/report.docx'])] }),
    ]);
    const files = collectFiles(conv);
    expect(files.map((f) => f.name)).toEqual(['copy.txt', 'report.docx']);
    expect(files[1].sources).toEqual([
      {
        path: `/api/organizations/${ORG}/conversations/${CONV}/wiggle/download-file?path=${encodeURIComponent('/mnt/user-data/outputs/report.docx')}`,
      },
    ]);
  });

  it('does not change the Markdown export', () => {
    const conv = chat([chatMsg('a', 'human', null, { files: [{ file_kind: 'image', file_name: 'b.png', file_uuid: U1, preview_url: preview(U1) }] })]);
    expect(renderMarkdown(conv, { exportedAt: new Date(0) })).toContain(`![b.png](https://claude.ai${preview(U1)})`);
  });
});

describe('collectFiles: Cowork', () => {
  const ev = (seq: number, source: string, event_type: string, payload: any) => ({
    event_id: `e${seq}`,
    sequence_num: seq,
    source,
    event_type,
    created_at: `2026-01-01T10:00:0${seq}Z`,
    payload,
  });
  const cowork = (): Conversation => ({
    kind: 'cowork',
    title: 'Cowork',
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: null,
    link: `https://claude.ai/chat/${CONV}`,
    orgId: ORG,
    conversationId: CONV,
    messages: coworkMessages(
      [
        ev(1, 'client', 'user', {
          message: { role: 'user', content: 'hi' },
          file_attachments: [
            { file_name: 'IMG.jpeg', file_uuid: U1, is_image: true },
            { file_name: 'notes.txt', file_uuid: U2, is_image: false },
          ],
        }),
        ev(2, 'worker', 'assistant', { message: { content: [{ type: 'tool_use', id: 'su', name: 'SendUserFile', input: {} }] } }),
        ev(3, 'worker', 'user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'su', content: 'ok' }] },
          tool_use_result: { attachments: [{ path: '/home/user/out/summary.pdf', file_uuid: U3 }, { path: '/home/user/out/IMG.jpeg', file_uuid: U1 }] },
        }),
        ev(4, 'worker', 'assistant', { message: { content: [{ type: 'tool_use', id: 'su2', name: 'SendUserFile', input: {} }] } }),
        ev(5, 'worker', 'user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'su2', content: 'ok' }] },
          tool_use_result: { attachments: [{ path: '/x/no-id.txt' }] },
        }),
      ],
      ORG,
    ),
  });

  it('collects uploads and SendUserFile attachments, deduped by file id', () => {
    expect(collectFiles(cowork())).toMatchObject([
      { name: 'IMG.jpeg', sources: [{ path: contents(U1) }, { path: preview(U1), ext: 'webp' }] },
      { name: 'notes.txt', sources: [{ path: contents(U2) }] },
      { name: 'summary.pdf', sources: [{ path: contents(U3) }] },
    ]);
  });

  it('keeps image URLs in the Markdown and adds a preview URL', () => {
    const img = cowork().messages[0].images[0];
    expect(img.url).toBe(`https://claude.ai${contents(U1)}`);
    expect(img.previewUrl).toBe(`https://claude.ai${preview(U1)}`);
  });
});

describe('names', () => {
  it('names the zip like the Markdown file', () => {
    expect(buildZipFilename('2026-03-05T10:00:00Z', 'My: test/file?')).toBe('2026-03-05 My test file – files.zip');
    expect(buildZipFilename(null, 'Title')).toBe('Title – files.zip');
    expect(buildZipFilename('2026-03-05T10:00:00Z', 'Titel', 'filer.zip')).toBe('2026-03-05 Titel – filer.zip');
  });

  it('appends (2), (3) before the extension, ignoring case', () => {
    const taken = new Set<string>();
    expect(uniqueName('a.txt', taken)).toBe('a.txt');
    expect(uniqueName('a.txt', taken)).toBe('a (2).txt');
    expect(uniqueName('A.TXT', taken)).toBe('A (3).TXT');
    expect(uniqueName('README', taken)).toBe('README');
    expect(uniqueName('README', taken)).toBe('README (2)');
    expect(uniqueName('.env', taken)).toBe('.env');
    expect(uniqueName('.env', taken)).toBe('.env (2)');
  });

  it('makes entry names safe', () => {
    expect(safeEntryName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeEntryName('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(safeEntryName('..')).toBe('file');
    expect(safeEntryName('')).toBe('file');
    expect(safeEntryName('räksmörgås.pdf')).toBe('räksmörgås.pdf');
  });
});

describe('buildFilesZip', () => {
  const file = (name: string, ...paths: string[]) => ({ name, sources: paths.map((path) => ({ path })) });

  it('zips the files with original names and numbers collisions', async () => {
    const data: Record<string, string> = { '/a': 'one', '/b': 'two', '/c': 'three' };
    const r = await buildFilesZip(bytesHttp((p) => bytes(data[p])), [file('x.txt', '/a'), file('x.txt', '/b'), file('y', '/c')]);
    expect(r.missing).toEqual([]);
    const entries = unzipSync(r.bytes!);
    expect(Object.keys(entries).sort()).toEqual(['x (2).txt', 'x.txt', 'y']);
    expect(strFromU8(entries['x.txt'])).toBe('one');
    expect(strFromU8(entries['x (2).txt'])).toBe('two');
    expect(strFromU8(entries['y'])).toBe('three');
  });

  it('uses the preview when the original is missing and renames to .webp', async () => {
    const log: string[] = [];
    const r = await buildFilesZip(
      bytesHttp((p) => (p === '/orig' ? 404 : bytes('webp-bytes')), log),
      [{ name: 'photo.png', sources: [{ path: '/orig' }, { path: '/prev', ext: 'webp' }] }],
    );
    expect(log).toEqual(['/orig', '/prev']);
    expect(Object.keys(unzipSync(r.bytes!))).toEqual(['photo.webp']);
    expect(r.missing).toEqual([]);
  });

  it('still zips what worked and lists the rest in missing.txt', async () => {
    const r = await buildFilesZip(
      bytesHttp((p) => (p === '/ok' ? bytes('fine') : p === '/403' ? 403 : p === '/net' ? new ExportError('network', 'x') : 404)),
      [file('good.txt', '/ok'), file('gone.pdf', '/gone'), file('forbidden.txt', '/403'), file('net.txt', '/net')],
    );
    expect(r.total).toBe(4);
    expect(r.added).toBe(1);
    expect(r.missing).toEqual([
      { name: 'gone.pdf', reason: 'not found' },
      { name: 'forbidden.txt', reason: 'no access' },
      { name: 'net.txt', reason: 'network error' },
    ]);
    const entries = unzipSync(r.bytes!);
    expect(Object.keys(entries).sort()).toEqual(['good.txt', 'missing.txt']);
    const text = strFromU8(entries['missing.txt']);
    expect(text).toContain('- gone.pdf (not found)');
    expect(text).toContain('- net.txt (network error)');
  });

  it('uses the texts it is given for the missing-files list', async () => {
    const sv: ZipTexts = {
      zipSuffix: 'filer.zip',
      missingFileName: 'saknas.txt',
      missingHeading: 'Följande filer kunde inte hämtas:',
      reasonNotFound: 'filen hittades inte',
      reasonNoAccess: 'ingen behörighet',
      reasonRateLimited: 'för många förfrågningar',
      reasonNetwork: 'nätverksfel',
      reasonUnknown: 'okänt fel',
    };
    const r = await buildFilesZip(
      bytesHttp((p) => (p === '/ok' ? bytes('fine') : p === '/403' ? 403 : 404)),
      [file('good.txt', '/ok'), file('gone.pdf', '/gone'), file('forbidden.txt', '/403')],
      undefined,
      sv,
    );
    expect(r.missing.map((m) => m.reason)).toEqual(['filen hittades inte', 'ingen behörighet']);
    const entries = unzipSync(r.bytes!);
    expect(Object.keys(entries).sort()).toEqual(['good.txt', 'saknas.txt']);
    expect(strFromU8(entries['saknas.txt'])).toBe('Följande filer kunde inte hämtas:\n\n- gone.pdf (filen hittades inte)\n- forbidden.txt (ingen behörighet)\n');
  });

  it('writes an English missing.txt by default', async () => {
    const r = await buildFilesZip(bytesHttp((p) => (p === '/ok' ? bytes('x') : 404)), [file('a.txt', '/ok'), file('b.txt', '/gone')]);
    expect(strFromU8(unzipSync(r.bytes!)['missing.txt'])).toBe('These files could not be fetched:\n\n- b.txt (not found)\n');
  });

  it('does not overwrite a real file called missing.txt', async () => {
    const r = await buildFilesZip(bytesHttp((p) => (p === '/ok' ? bytes('mine') : 404)), [file('missing.txt', '/ok'), file('x', '/gone')]);
    const entries = unzipSync(r.bytes!);
    expect(strFromU8(entries['missing.txt'])).toBe('mine');
    expect(Object.keys(entries).sort()).toEqual(['missing (2).txt', 'missing.txt']);
  });

  it('returns no zip when every file fails', async () => {
    const r = await buildFilesZip(bytesHttp(() => 404), [file('a', '/a'), file('b', '/b')]);
    expect(r.bytes).toBeNull();
    expect(r.missing).toHaveLength(2);
  });

  it('fetches at most three files at a time and reports progress', async () => {
    let active = 0;
    let peak = 0;
    const http: Http = {
      getJson: () => Promise.reject(new Error('unused')),
      postJson: () => Promise.reject(new Error('unused')),
      getBytes: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return bytes('x');
      },
    };
    const progress: number[] = [];
    const files = Array.from({ length: 10 }, (_, i) => file(`f${i}`, `/f${i}`));
    const r = await buildFilesZip(http, files, (done) => progress.push(done));
    expect(peak).toBe(3);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Object.keys(unzipSync(r.bytes!))).toHaveLength(10);
  });

  it('handles large files (12 MB) byte for byte, stored without compression for known formats', async () => {
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    const r = await buildFilesZip(bytesHttp(() => big), [file('large.pdf', '/big'), file('large.csv', '/big')]);
    const entries = unzipSync(r.bytes!);
    expect(entries['large.pdf']).toEqual(big);
    expect(entries['large.csv']).toEqual(big);
  }, 30_000); // slow on CI runners

  it('writes a valid zip: local header signature, end-of-central-directory record, UTF-8 names', async () => {
    const r = await buildFilesZip(bytesHttp(() => bytes('hi')), [file('räksmörgås.txt', '/a')]);
    const b = r.bytes!;
    expect([...b.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const eocd = b.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(1); // entries
    expect(Object.keys(unzipSync(b))).toEqual(['räksmörgås.txt']);
  });
});

describe('embedImages', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const conv = (): Conversation => {
    const c = chat([
      chatMsg('a', 'human', null, {
        files: [
          { file_kind: 'image', file_name: 'a.png', file_uuid: U1, preview_url: preview(U1) },
          { file_kind: 'image', file_name: 'b.png', file_uuid: U2, preview_url: preview(U2) },
        ],
      }),
    ]);
    return c;
  };

  it('replaces image urls with data urls and keeps the url when a fetch fails', async () => {
    const out = await embedImages(bytesHttp((p) => (p === preview(U1) ? PNG : 404)), conv());
    expect(out.messages[0].images[0].url).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
    expect(out.messages[0].images[1].url).toBe(`https://claude.ai${preview(U2)}`);
  });

  it('does not modify the input conversation', async () => {
    const c = conv();
    await embedImages(bytesHttp(() => PNG), c);
    expect(c.messages[0].images[0].url).toBe(`https://claude.ai${preview(U1)}`);
  });

  it('ignores responses that are not images', async () => {
    const out = await embedImages(bytesHttp(() => bytes('<html>login</html>')), conv());
    expect(out.messages[0].images[0].url).toBe(`https://claude.ai${preview(U1)}`);
  });
});

describe('listFiles', () => {
  it('counts the files of a chat and names the zip', async () => {
    const tree = {
      name: 'My chat',
      created_at: '2026-03-05T10:00:00Z',
      current_leaf_message_uuid: 'a',
      chat_messages: [chatMsg('a', 'human', null, { files: [{ file_kind: 'document', file_name: 'x.pdf', file_uuid: U1 }] })],
    };
    const http: Http = {
      getJson: async () => tree,
      postJson: () => Promise.reject(new Error('unused')),
      getBytes: () => Promise.reject(new Error('unused')),
    };
    const r = await listFiles(http, { href: `https://claude.ai/chat/3f2a9c1e-5b7d-4e4f-9a1b-2c3d4e5f6a7b`, orgCookie: ORG, hook: emptyHookState() });
    expect(r.zipFilename).toBe('2026-03-05 My chat – files.zip');
    expect(r.files).toHaveLength(1);
  });
});

describe('listFiles texts', () => {
  it('names the zip with the given suffix', async () => {
    const tree = { name: 'Min chatt', created_at: '2026-03-05T10:00:00Z', current_leaf_message_uuid: 'a', chat_messages: [chatMsg('a', 'human', null, {})] };
    const http: Http = { getJson: async () => tree, postJson: () => Promise.reject(new Error('unused')), getBytes: () => Promise.reject(new Error('unused')) };
    const ctx = { href: 'https://claude.ai/chat/3f2a9c1e-5b7d-4e4f-9a1b-2c3d4e5f6a7b', orgCookie: ORG, hook: emptyHookState() };
    const r = await listFiles(http, ctx, { ...DEFAULT_ZIP_TEXTS, zipSuffix: 'filer.zip' });
    expect(r.zipFilename).toBe('2026-03-05 Min chatt – filer.zip');
  });
});

describe('private fixtures', () => {
  const fx = loadPrivate<{ org: string; chats: Record<string, any> }>('files-chats.json');
  const suite = fx ? describe : describe.skip;
  suite('real chats with files', () => {
    it('finds every listed file with an id exactly once', () => {
      for (const raw of Object.values(fx!.chats)) {
        const conv = normaliseChat(raw, { link: 'https://claude.ai/chat/x', orgId: fx!.org, conversationId: raw.uuid });
        const ids = new Set<string>();
        for (const m of raw.chat_messages) for (const f of m.files ?? []) if (f.file_uuid) ids.add(f.file_uuid);
        const files = collectFiles(conv);
        expect(files).toHaveLength(ids.size);
        for (const f of files) expect(f.sources[0].path).toMatch(/\/files\/[0-9a-f-]{36}\/contents$/);
      }
    });
  });
});

describe('zip file dates', () => {
  it('sets each entry date from createdAt, in local time', async () => {
    const http: Http = {
      getJson: async () => ({}),
      getBytes: async () => new Uint8Array([1, 2, 3]),
    } as unknown as Http;
    const created = '2026-03-04T05:06:08Z';
    const r = await buildFilesZip(http, [
      { name: 'a.txt', sources: [{ path: '/a' }], createdAt: created },
      { name: 'b.txt', sources: [{ path: '/b' }], createdAt: null },
    ]);
    const bytes = r.bytes!;
    // Local file header: DOS time at offset 10, DOS date at offset 12.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    const d = new Date(created);
    expect(date >> 9).toBe(d.getFullYear() - 1980);
    expect((date >> 5) & 0xf).toBe(d.getMonth() + 1);
    expect(date & 0x1f).toBe(d.getDate());
    expect(time >> 11).toBe(d.getHours());
    expect((time >> 5) & 0x3f).toBe(d.getMinutes());
  });

  it('ignores missing, invalid and pre-1980 dates', () => {
    expect(zipDate(null)).toBeUndefined();
    expect(zipDate('nonsense')).toBeUndefined();
    expect(zipDate('1970-01-01T00:00:00Z')).toBeUndefined();
    expect(zipDate('2026-11-23T18:16:16Z')).toBeInstanceOf(Date);
  });
});
