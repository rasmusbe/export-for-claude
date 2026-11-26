import { describe, expect, it } from 'vitest';
import { mergeSameSender, selectBranch } from '../src/core/branch';
import { normaliseChat } from '../src/core/chat';
import { coworkMessages } from '../src/core/cowork';
import {
  buildFilename,
  collapseBlankLines,
  fixNestedFences,
  formatDate,
  formatDateTime,
  sanitizeTitle,
  stripSystemReminders,
} from '../src/core/format';
import { renderMarkdown } from '../src/core/markdown';
import { isUuidV8, parsePage } from '../src/core/page';
import { chatStepName, chatSummary, coworkStepName, coworkSummary } from '../src/core/steps';
import type { Block, ToolUseBlock } from '../src/core/types';

const msg = (uuid: string, sender: string, parent: string | null, text = uuid) => ({
  uuid,
  sender,
  parent_message_uuid: parent,
  content: [{ type: 'text', text }],
  updated_at: `2026-01-01T00:00:0${uuid.length % 10}Z`,
});

describe('branch walk', () => {
  it('follows parents from the leaf and skips other branches', () => {
    const all = [msg('a', 'human', null), msg('b', 'assistant', 'a'), msg('c1', 'human', 'b'), msg('c2', 'human', 'b'), msg('d', 'assistant', 'c2')];
    expect(selectBranch(all, 'd').map((m) => m.uuid)).toEqual(['a', 'b', 'c2', 'd']);
  });

  it('prepends everything before a legacy message without parent', () => {
    const all = [msg('x', 'human', null), msg('y', 'assistant', null), msg('z', 'human', 'y')];
    expect(selectBranch(all, 'z').map((m) => m.uuid)).toEqual(['x', 'y', 'z']);
  });

  it('returns all messages without a leaf, or when the leaf is unknown', () => {
    const all = [msg('a', 'human', null), msg('b', 'assistant', 'a')];
    expect(selectBranch(all, null).map((m) => m.uuid)).toEqual(['a', 'b']);
    expect(selectBranch(all, 'nope').map((m) => m.uuid)).toEqual(['a', 'b']);
  });

  it('stops on parent cycles', () => {
    const all = [msg('a', 'human', 'b'), msg('b', 'assistant', 'a')];
    expect(selectBranch(all, 'b').map((m) => m.uuid)).toEqual(['a', 'b']);
  });

  it('merges consecutive same-sender messages without mutating input', () => {
    const a = { ...msg('a', 'assistant', null), files: [{ n: 1 }], attachments: [] };
    const b = { ...msg('b', 'assistant', 'a'), files: [{ n: 2 }], sync_sources: [{ s: 1 }] };
    const c = msg('c', 'human', 'b');
    const out = mergeSameSender<any>([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toEqual([...a.content, ...b.content]);
    expect(out[0].files).toEqual([{ n: 1 }, { n: 2 }]);
    expect(out[0].sync_sources).toEqual([{ s: 1 }]);
    expect(out[0].updated_at).toBe(b.updated_at);
    expect(a.content).toHaveLength(1);
  });
});

describe('dates and filenames', () => {
  it('formats local time zero padded', () => {
    // vitest.config.ts pins TZ to Europe/Stockholm (UTC+1 in winter)
    expect(formatDateTime('2026-11-25T06:45:01.684Z')).toBe('2026-11-25 07:45:01');
    expect(formatDateTime('2026-01-02T03:04:05Z')).toBe('2026-01-02 04:04:05');
    expect(formatDateTime('2026-07-01T22:30:00Z')).toBe('2026-07-02 00:30:00');
    expect(formatDate('2026-11-25T23:30:00Z')).toBe('2026-11-26');
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('nonsense')).toBe('');
  });

  it('sanitises titles for the filesystem', () => {
    expect(sanitizeTitle('A/B: "c" <d>|e?*')).toBe('A B c d e');
    expect(sanitizeTitle('  ..hidden. ')).toBe('hidden');
    expect(sanitizeTitle('')).toBe('Claude');
    expect(sanitizeTitle('CON')).toBe('_CON');
    expect(sanitizeTitle('line\nbreak\ttab')).toBe('line break tab');
    expect(sanitizeTitle('x'.repeat(300))).toHaveLength(120);
    expect(sanitizeTitle('Väderkoll')).toBe('Väderkoll');
  });

  it('builds YYYY-MM-DD Title.ext from the created date', () => {
    expect(buildFilename('2026-11-25T06:45:01Z', 'Väderkoll', 'md')).toBe('2026-11-25 Väderkoll.md');
    expect(buildFilename(null, 'a/b', 'json')).toBe('a b.json');
  });
});

describe('text clean-up', () => {
  it('strips system-reminder blocks anywhere in the text', () => {
    const t = 'Hi\n<system-reminder>This task fired at X.\nMore</system-reminder>\nend<system-reminder>y</system-reminder>';
    expect(stripSystemReminders(t)).toBe('Hi\n\nend');
  });

  it('collapses 3+ blank lines outside fences only', () => {
    const md = 'a\n\n\n\nb\n```\nx\n\n\n\ny\n```\nc';
    expect(collapseBlankLines(md)).toBe('a\n\nb\n```\nx\n\n\n\ny\n```\nc');
  });

  it('lengthens an outer fence that contains equally long fences', () => {
    const t = '```markdown\n# Doc\n```js\ncode\n```\n```';
    expect(fixNestedFences(t)).toBe('````markdown\n# Doc\n```js\ncode\n```\n````');
  });

  it('removes system reminders from Cowork user turns and drops subagent events', () => {
    const events = [
      { sequence_num: '1', source: 'client', event_type: 'user', created_at: '2026-01-01T10:00:00Z', payload: { message: { role: 'user', content: 'Question\n<system-reminder>secret</system-reminder>' } } },
      { sequence_num: '2', source: 'worker', event_type: 'assistant', created_at: '2026-01-01T10:00:01Z', payload: { message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] } } },
      { sequence_num: '3', source: 'worker', event_type: 'assistant', created_at: '2026-01-01T10:00:02Z', payload: { parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'subagent says hi' }] } } },
      { sequence_num: '4', source: 'worker', event_type: 'assistant', created_at: '2026-01-01T10:00:03Z', payload: { message: { content: [{ type: 'text', text: 'Answer' }] } } },
    ];
    const ms = coworkMessages(events, 'org');
    expect(ms.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ms[0].blocks).toEqual([{ type: 'text', text: 'Question' }]);
    expect(JSON.stringify(ms[1])).not.toContain('subagent says hi');
    expect(ms[1].time).toBe('2026-01-01T10:00:03Z');
  });
});

const tool = (name: string, input: Record<string, unknown> = {}, message?: string): ToolUseBlock => ({
  type: 'tool_use',
  id: name,
  name,
  input,
  message,
});

describe('step names', () => {
  it('names Cowork steps', () => {
    expect(coworkStepName(tool('mcp__Weather_Station__get_state'))).toBe('Weather_Station: get_state');
    expect(coworkStepName(tool('mcp__claude-code-remote__send_later'))).toBe('Claude-code-remote: send_later');
    expect(coworkStepName(tool('Read', { file_path: '/a/b/notes.md' }))).toBe('Read notes.md');
    expect(coworkStepName(tool('Write', { file_path: '/a/x.ts' }))).toBe('Created x.ts');
    expect(coworkStepName(tool('Edit', { file_path: 'y.ts' }))).toBe('Edited y.ts');
    expect(coworkStepName(tool('Bash', { description: 'Run tests' }))).toBe('Run tests');
    expect(coworkStepName(tool('Bash', {}))).toBe('Bash');
    expect(coworkStepName(tool('WebSearch', { query: 'coffee' }))).toBe('Searched: coffee');
    expect(coworkStepName(tool('WebFetch', { url: 'https://x.se' }))).toBe('Fetched: https://x.se');
    expect(coworkStepName(tool('ToolSearch'))).toBe('Found tools');
    expect(coworkStepName(tool('Agent'))).toBe('Tool: Agent');
    expect(coworkStepName(tool('mcp__memory__memory_read', { path: '/topics/a.md' }))).toBe('memory_read /topics/a.md');
    expect(coworkStepName(tool('TaskCreate', { subject: 'Fix' }))).toBe('Added task: Fix');
  });

  it('names chat steps from the API label first', () => {
    expect(chatStepName(tool('bash_tool', { description: 'd' }, 'Running tests'))).toBe('Running tests');
    expect(chatStepName(tool('web_search', { query: 'q' }, 'Searching'))).toBe('q');
    expect(chatStepName(tool('x', { description: 'desc' }))).toBe('desc');
    expect(chatStepName(tool('mcp__srv__method'))).toBe('Srv: method');
    expect(chatStepName(tool('mystery'))).toBe('Tool: mystery');
  });
});

describe('summary lines', () => {
  it('builds the Cowork summary in a fixed order', () => {
    const items: Block[] = [
      tool('Bash'),
      tool('Agent'),
      tool('mcp__Weather_Station__a'),
      tool('ToolSearch'),
      tool('Read'),
      tool('Bash'),
      tool('WebSearch'),
      tool('SendMessage'),
      tool('mcp__Notes__b'),
    ];
    expect(coworkSummary(items)).toBe(
      'Used 2 tools, loaded tools, used Weather_Station integration, used Notes integration, searched the web, read a file, ran 2 commands',
    );
    expect(coworkSummary([tool('Bash')])).toBe('Ran a command');
    expect(coworkSummary([])).toBe('');
  });

  it('prefers the thinking summary in chats, else counts', () => {
    expect(chatSummary([{ type: 'thinking', summary: 'Planerar.' }, tool('web_search')])).toBe('Planerar.');
    expect(chatSummary([tool('web_search'), tool('bash_tool'), tool('bash_tool'), tool('other')])).toBe(
      'Searched the web, ran 2 commands, used tool',
    );
  });
});

describe('pages', () => {
  it('detects page kinds and v8 ids', () => {
    expect(parsePage('https://claude.ai/chat/3f2a9c1e-5b7d-8e4f-9a1b-2c3d4e5f6a7b')).toEqual({ kind: 'chat', id: '3f2a9c1e-5b7d-8e4f-9a1b-2c3d4e5f6a7b' });
    expect(parsePage('https://claude.ai/share/7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6').kind).toBe('share');
    expect(parsePage('https://claude.ai/new?incognito').kind).toBe('new');
    expect(parsePage('https://claude.ai/projects').kind).toBe('other');
    expect(parsePage('https://example.com/chat/7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6').kind).toBe('other');
    expect(isUuidV8('3f2a9c1e-5b7d-8e4f-9a1b-2c3d4e5f6a7b')).toBe(true);
    expect(isUuidV8('7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6')).toBe(false);
  });
});

describe('chat rendering', () => {
  const chat = {
    name: 'Test',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T11:00:00Z',
    current_leaf_message_uuid: 'a2',
    chat_messages: [
      {
        uuid: 'u1',
        sender: 'human',
        parent_message_uuid: null,
        updated_at: '2026-01-01T10:00:00Z',
        content: [{ type: 'text', text: 'Hi' }],
        files_v2: [{ file_kind: 'image', file_name: 'a.png', preview_url: '/api/x/preview' }],
        attachments: [{ file_name: '', file_type: 'txt', extracted_content: 'paste ``` inside' }],
      },
      {
        uuid: 'a2',
        sender: 'assistant',
        parent_message_uuid: 'u1',
        updated_at: '2026-01-01T10:01:00Z',
        content: [
          { type: 'thinking', thinking: 'full secret thinking', summaries: [{ summary: 'Thinking about it.' }] },
          { type: 'tool_use', id: 's', name: 'web_search', input: { query: 'coffee' }, message: 'Searching the web' },
          { type: 'tool_result', tool_use_id: 's', name: 'web_search', content: [{ type: 'knowledge', title: 'Coffee', url: 'https://coffee.example' }, { type: 'knowledge', title: 'Coffee', url: 'https://coffee.example' }] },
          { type: 'text', text: 'Answer.' },
          { type: 'tool_use', id: 'c', name: 'artifacts', input: { id: 'doc', command: 'create', title: 'Doc', type: 'text/markdown', content: 'one two' } },
          { type: 'tool_result', tool_use_id: 'c', name: 'artifacts', content: [{ type: 'text', text: 'OK' }] },
          { type: 'tool_use', id: 'u', name: 'artifacts', input: { id: 'doc', command: 'update', old_str: 'one', new_str: 'ONE' } },
          { type: 'tool_result', tool_use_id: 'u', name: 'artifacts', content: [{ type: 'text', text: 'OK' }] },
          { type: 'tool_use', id: 'u2', name: 'artifacts', input: { id: 'doc', command: 'update', old_str: 'two', new_str: 'TWO' } },
          { type: 'tool_result', tool_use_id: 'u2', name: 'artifacts', content: [{ type: 'text', text: 'OK' }] },
        ],
      },
    ],
  };

  it('renders header, files, steps, artifacts and sources', () => {
    const conv = normaliseChat(chat, { link: 'https://claude.ai/chat/x', orgId: 'o', conversationId: 'x' });
    const md = renderMarkdown(conv, { exportedAt: '2026-01-02T00:00:00Z' });
    expect(md).toContain('# Test\n\n**Created:** 2026-01-01 11:00:00  \n**Updated:** 2026-01-01 12:00:00  \n**Exported:** 2026-01-02 01:00:00  \n**Link:** [https://claude.ai/chat/x](https://claude.ai/chat/x)  \n\n## User:');
    expect(md).toContain('![a.png](https://claude.ai/api/x/preview)');
    expect(md).toContain('````text\npaste ``` inside\n````');
    expect(md).toContain('> Thinking about it.\n>\n> - Thinking about it.\n> - coffee\n> - **Done**');
    expect(md).not.toContain('full secret thinking');
    expect(md).toContain('**Doc**\n\n````markdown\none two\n````');
    // The first update is hidden; the last shows the final version.
    expect(md).not.toContain('Version 2');
    expect(md).toContain('**Doc** ∙ Version 3\n\n````markdown\nONE TWO\n````');
    expect(md).toContain('---\n\n**Sources:**\n\n- [Coffee](https://coffee.example)\n');
    expect(md.match(/coffee\.example/g)).toHaveLength(1);
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/\n\n\n/);
  });
});
