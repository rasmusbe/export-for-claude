// Golden test against a reference export of the same Cowork chat.
// Needs the private fixtures; skipped when they are missing.

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseCowork } from '../src/core/cowork';
import { renderMarkdown } from '../src/core/markdown';
import { coworkStepName } from '../src/core/steps';
import { PRIVATE, lineDiff, loadPrivate } from './helpers';

const fixture = loadPrivate('cowork-golden-events.json');
const expectedName = (() => {
  try {
    return readdirSync(join(PRIVATE, 'expected')).find((f) => f.endsWith('.md'));
  } catch {
    return undefined;
  }
})();
const expected = expectedName ? loadPrivate<string>(join('expected', expectedName)) : null;

/** Bring the reference export in line with our format (DESIGN.md). */
function normaliseExpected(md: string): string {
  const pad = (n: string) => n.padStart(2, '0');
  return md
    .replace(/(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})/g, (_m, mo, d, y, h, mi, s) => `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${mi}:${s}`)
    .replace(/\n*Powered by [^\n]*\n*$/, '\n')
    .replace(/\n?<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

/**
 * Every remaining difference must come from subagent events, which the
 * original mixed into the main assistant turn and we skip:
 * - step lines of tool calls made by a subagent,
 * - the subagent's own text and its separate step group,
 * - summary lines whose counts included the subagent's tools.
 */
function subagentStepLines(events: any[]): Set<string> {
  const lines = new Set<string>(['> - **Done**', '>', '']);
  for (const e of events) {
    if (!e.payload?.parent_tool_use_id || e.event_type !== 'assistant') continue;
    for (const b of e.payload.message?.content ?? []) {
      if (b?.type === 'tool_use') lines.add(`> - ${coworkStepName({ type: 'tool_use', id: b.id, name: b.name, input: b.input })}`);
      if (b?.type === 'text' && b.text) for (const l of b.text.split('\n')) lines.add(l);
    }
  }
  return lines;
}

// Summary lines only (no assistant text): "> Used 2 tools, ran a command".
const SUMMARY_RE = /^> (Used|Loaded|Searched|Ran|Read|Created|Edited) [^\n]*$/i;

describe.skipIf(!fixture || !expected)('golden: Cowork export', () => {
  it('matches the reference export apart from the agreed deviations', () => {
    const conv = normaliseCowork(fixture.session, fixture.events, {
      link: `https://claude.ai/chat/${fixture.chatUuid}`,
      orgId: fixture.org,
      conversationId: fixture.chatUuid,
    });
    const exportedAt = '2026-11-26T08:42:44Z';
    const ours = renderMarkdown(conv, { exportedAt });
    writeFileSync(join(PRIVATE, 'golden-actual.md'), ours);

    const want = normaliseExpected(expected!).trimEnd().split('\n');
    const got = ours.trimEnd().split('\n');
    const diff = lineDiff(want, got);
    writeFileSync(join(PRIVATE, 'golden-diff.txt'), diff.join('\n') + '\n');

    const allowed = subagentStepLines(fixture.events);
    const unexplained = diff.filter((l) => {
      const [, sign, text] = l.match(/^([-+])\d+: ([\s\S]*)$/)!;
      if (SUMMARY_RE.test(text)) return false; // counts changed
      return !(sign === '-' && (allowed.has(text) || SUMMARY_RE.test(text)));
    });
    expect(unexplained).toEqual([]);
    // No subagent text may appear as assistant text.
    for (const e of fixture.events) {
      if (!e.payload?.parent_tool_use_id || e.event_type !== 'assistant') continue;
      for (const b of e.payload.message?.content ?? []) if (b?.type === 'text' && b.text?.trim()) expect(ours).not.toContain(b.text.trim());
    }
    expect(ours).not.toContain('<system-reminder>');
    expect(ours).not.toContain('Powered by');
  });
});
