// Markdown renderer for the internal model.

import { ArtifactRegistry, artifactLanguage, isArtifactCall, renderArtifact } from './artifacts';
import { collapseBlankLines, fenceFor, fixNestedFences, formatDateTime, orgFileUrl } from './format';
import { chatStepName, chatSummary, coworkStepName, coworkSummary } from './steps';
import type { Block, Conversation, Json, Message, ToolResultBlock, ToolUseBlock } from './types';

export interface RenderOptions {
  /** Export time; defaults to now. */
  exportedAt?: Date | string | number;
}

interface Source {
  title: string;
  url: string;
}

interface Ctx {
  conv: Conversation;
  registry: ArtifactRegistry;
}

type Segment = { kind: 'single'; block: Block } | { kind: 'group'; items: Block[] };

const CHAT_SKIPPED_TOOLS = new Set(['visualize:read_me', 'ask_user_input_v0']);
const WIDGET_TOOL = 'visualize:show_widget';

function isAskUser(b: Block): boolean {
  return (b.type === 'tool_use' || b.type === 'tool_result') && b.name === 'AskUserQuestion';
}

/** Split content into single blocks and step groups (runs of thinking and tool steps). */
export function segment(blocks: Block[], cowork: boolean): Segment[] {
  const out: Segment[] = [];
  let group: Block[] | null = null;
  for (const b of blocks) {
    if ((b as { hidden?: boolean }).hidden) continue;
    if (b.type === 'text' && !b.text.trim()) continue;
    if (!cowork && (b.type === 'tool_use' || b.type === 'tool_result') && b.name && CHAT_SKIPPED_TOOLS.has(b.name)) continue;

    let grouped: boolean;
    if (b.type === 'thinking') grouped = true;
    else if (cowork) grouped = (b.type === 'tool_use' || b.type === 'tool_result') && !isAskUser(b);
    else if (b.type === 'tool_result') grouped = true;
    else if (b.type === 'tool_use') grouped = !isArtifactCall(b.input) && b.name !== WIDGET_TOOL;
    else grouped = false;

    if (grouped) {
      if (!group) {
        group = [];
        out.push({ kind: 'group', items: group });
      }
      group.push(b);
    } else {
      group = null;
      out.push({ kind: 'single', block: b });
    }
  }
  return out;
}

function renderText(text: string): string {
  let s = fixNestedFences(text);
  s = s.replace(/<antArtifact([^>]*)>([\s\S]*?)<\/antArtifact>/g, (_m, attrs: string, body: string) => {
    const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const title = attr('title');
    const lang = artifactLanguage(attr('type'), attr('language'));
    return `${title ? `${title}\n\n` : ''}\`\`\`\`${lang}\n${(body || '').trim()}\n\`\`\`\`\n\n`;
  });
  return `${s.trim()}\n\n`;
}

function stepLines(items: Block[], cowork: boolean, summary: string): string {
  const lines: string[] = [];
  if (summary) lines.push(`> ${summary}`, '>');
  for (const b of items) {
    // Thinking only contributes the summary line above, not a list item.
    if (b.type === 'tool_use') {
      if (!cowork && b.name === 'web_fetch') {
        const { title, url, domain } = webFetchInfo(items, b);
        const label = domain ? `${title} (${domain})` : title;
        lines.push(url ? `> - [${label}](${url})` : `> - ${label}`);
      } else {
        lines.push(`> - ${cowork ? coworkStepName(b) : chatStepName(b)}`);
      }
    }
  }
  lines.push('> - **Done**');
  return `${lines.join('\n')}\n\n`;
}

function webFetchInfo(items: Block[], tool: ToolUseBlock): { title: string; url: string; domain: string } {
  const fallback = String(tool.input?.url ?? '');
  const result = items.find(
    (b): b is ToolResultBlock => b.type === 'tool_result' && b.name === 'web_fetch' && (!tool.id || b.toolUseId === tool.id),
  );
  const first = Array.isArray(result?.content) ? (result!.content[0] as Json) : undefined;
  const url = first?.url || fallback;
  return { title: first?.title || url, url, domain: first?.metadata?.site_domain || '' };
}

function groupSources(items: Block[], cowork: boolean): Source[] {
  const out: Source[] = [];
  for (const b of items) {
    if (b.type !== 'tool_result') continue;
    if (cowork && b.name === 'WebSearch') {
      for (const r of ((b.toolUseResult as Json)?.results ?? []) as Json[]) {
        for (const c of (r?.content ?? []) as Json[]) if (c?.title && c?.url) out.push({ title: c.title, url: c.url });
      }
    } else if (!cowork && b.name === 'web_search' && Array.isArray(b.content)) {
      for (const c of b.content as Json[]) if (c?.type === 'knowledge' && c.title && c.url) out.push({ title: c.title, url: c.url });
    }
  }
  return out;
}

/** Output of the analysis tool (`repl`) in chats. */
function renderChatToolResult(b: ToolResultBlock): string {
  if (!Array.isArray(b.content) || b.content.length !== 1) return '';
  const c = b.content[0] as Json;
  if (c?.type !== 'text' || typeof c.text !== 'string') return '';
  let parsed: Json | null = null;
  try {
    parsed = JSON.parse(c.text);
  } catch {
    return '';
  }
  if (!parsed?.status || !(parsed.logs || parsed.error !== undefined)) return '';
  if (parsed.status === 'success') {
    const text = (parsed.logs ?? []).join('\n\n');
    const f = fenceFor(text, 4);
    return `**Output**\n\n${f}plaintext\n${text}\n${f}\n\n`;
  }
  const err = String(parsed.error ?? '');
  const f = fenceFor(err, 4);
  return `**Error**\n\n${f}plaintext\n${err}\n${f}\n\n`;
}

function renderAskUser(result: ToolResultBlock, msg: Message): string {
  const use = msg.blocks.find((b): b is ToolUseBlock => b.type === 'tool_use' && b.id === result.toolUseId);
  const questions = (use?.input?.questions ?? []) as Json[];
  if (!questions.length) return '';
  const answers = ((result.toolUseResult as Json)?.answers ?? {}) as Record<string, string>;
  let out = `> **${questions.length === 1 ? 'Asked 1 question' : `Asked ${questions.length} questions`}**\n`;
  for (const q of questions) {
    const a = answers[q.question];
    out += a ? `> - **${q.question}** — ${a}\n` : `> - ${q.question}\n`;
  }
  return `${out}\n`;
}

function renderArtifactCall(b: ToolUseBlock, ctx: Ctx, hidden: boolean): string {
  const input = b.input ?? {};
  if (input.title && input.command === 'create' && input.content) {
    return hidden ? (ctx.registry.create(input), '') : renderArtifact(ctx.registry.create(input));
  }
  if (input.command === 'update' && input.old_str) {
    if (ctx.registry.get(input.id)) {
      const a = ctx.registry.update(input);
      return hidden ? '' : renderArtifact(a);
    }
    // Update of an artifact we never saw created: show the new fragment.
    const a = ctx.registry.create(input, input.new_str ?? '');
    return hidden ? '' : renderArtifact({ ...a, content: input.new_str ?? '', version: 1 });
  }
  if (input.command === 'rewrite' && input.content) {
    if (!ctx.registry.get(input.id)) return '';
    const a = ctx.registry.rewrite(input);
    return hidden ? '' : renderArtifact(a);
  }
  return '';
}

function renderAttachments(msg: Message): string {
  let out = '';
  for (const img of msg.images) out += `![${img.name}](${img.url})\n\n`;
  for (const f of msg.files) out += `> File: ${f}\n\n`;
  for (const n of msg.notes) out += `${n}\n\n`;
  for (const p of msg.pastes) {
    const fence = fenceFor(p.text);
    out += `${fence}text\n${p.text}${p.text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  }
  for (const s of msg.syncSources) out += `> ${s.label}: [${s.title}](${s.url})\n\n`;
  return out;
}

function presentedFileUrl(path: string, conv: Conversation): string | null {
  if (!conv.orgId || !conv.conversationId) return null;
  return (
    `https://claude.ai/api/organizations/${encodeURIComponent(conv.orgId)}` +
    `/conversations/${encodeURIComponent(conv.conversationId)}/wiggle/download-file?path=${encodeURIComponent(path)}`
  );
}

/** Body of one message (without the `## Role:` heading and time). */
export function renderMessageBody(msg: Message, ctx: Ctx): string {
  const cowork = ctx.conv.kind === 'cowork';
  const parts: string[] = [];
  const sources: Source[] = [];
  const files: { path: string; url: string | null }[] = [];

  if (msg.role === 'user') parts.push(renderAttachments(msg));

  // Hidden artifact updates are skipped by segment() but must still advance
  // the registry, so replay them in order alongside the visible blocks.
  const hiddenBefore = new Map<Block, ToolUseBlock[]>();
  let pendingHidden: ToolUseBlock[] = [];
  for (const b of msg.blocks) {
    if ((b as { hidden?: boolean }).hidden) {
      if (b.type === 'tool_use') pendingHidden.push(b);
    } else if (pendingHidden.length) {
      hiddenBefore.set(b, pendingHidden);
      pendingHidden = [];
    }
  }
  const replayHidden = (b: Block) => {
    for (const h of hiddenBefore.get(b) ?? []) renderArtifactCall(h, ctx, true);
  };

  for (const seg of segment(msg.blocks, cowork)) {
    if (seg.kind === 'group') {
      seg.items.forEach(replayHidden);
      const items = seg.items;
      sources.push(...groupSources(items, cowork));
      const summary = cowork ? coworkSummary(items) : chatSummary(items);

      for (const b of items) {
        if (b.type !== 'tool_use') continue;
        if (cowork && b.name === 'SendUserFile') {
          // Paths come from the matching result.
        } else if (!cowork && b.name === 'present_files' && Array.isArray(b.input?.filepaths)) {
          for (const p of b.input!.filepaths as string[]) files.push({ path: p, url: presentedFileUrl(p, ctx.conv) });
        }
      }
      if (cowork) {
        for (const b of items) {
          if (b.type !== 'tool_result' || b.name !== 'SendUserFile') continue;
          for (const a of ((b.toolUseResult as Json)?.attachments ?? []) as Json[]) {
            if (a?.path) files.push({ path: a.path, url: orgFileUrl(ctx.conv.orgId, a.file_uuid) });
          }
        }
      }

      const hasSteps = items.some((b) => b.type === 'tool_use');
      if (hasSteps) {
        parts.push(stepLines(items, cowork, summary));
        if (!cowork) {
          for (const b of items) {
            if (b.type === 'tool_result' && b.name !== 'web_search' && b.name !== 'web_fetch') parts.push(renderChatToolResult(b));
          }
        }
      } else if (summary) {
        parts.push(`> ${summary}\n\n`);
      }
      continue;
    }

    const b = seg.block;
    replayHidden(b);
    if (b.type === 'text') {
      parts.push(renderText(b.text));
    } else if (b.type === 'tool_use') {
      if (cowork) continue; // AskUserQuestion: rendered from its result
      if (b.name === WIDGET_TOOL) parts.push(`> [Interactive Widget: ${b.input?.title || 'Widget'}]\n\n`);
      else parts.push(renderArtifactCall(b, ctx, false));
    } else if (b.type === 'tool_result' && cowork) {
      parts.push(renderAskUser(b, msg));
    }
  }
  for (const h of pendingHidden) renderArtifactCall(h, ctx, true);

  for (const f of files) parts.push(f.url ? `> File: [${f.path}](${f.url})\n\n` : `> File: ${f.path}\n\n`);

  if (sources.length) {
    const seen = new Set<string>();
    const unique = sources.filter((s) => !seen.has(s.url) && seen.add(s.url));
    parts.push(`---\n\n**Sources:**\n\n${unique.map((s) => `- [${s.title}](${s.url})`).join('\n')}\n\n`);
  }
  return parts.join('');
}

export function renderHeader(conv: Conversation, exportedAt: Date | string | number): string {
  const lines = [`# ${conv.title}`, ''];
  if (conv.createdAt) lines.push(`**Created:** ${formatDateTime(conv.createdAt)}  `);
  if (conv.updatedAt) lines.push(`**Updated:** ${formatDateTime(conv.updatedAt)}  `);
  lines.push(`**Exported:** ${formatDateTime(exportedAt)}  `);
  lines.push(`**Link:** [${conv.link}](${conv.link})  `);
  return `${lines.join('\n')}\n\n`;
}

export interface RenderedMessage {
  role: Message['role'];
  time: string | null;
  markdown: string;
}

/** Each message's body as Markdown, sharing one artifact registry. */
export function renderMessages(conv: Conversation): RenderedMessage[] {
  const ctx: Ctx = { conv, registry: new ArtifactRegistry() };
  return conv.messages.map((m) => ({
    role: m.role,
    time: m.time,
    markdown: collapseBlankLines(renderMessageBody(m, ctx)).trim(),
  }));
}

export function renderMarkdown(conv: Conversation, opts: RenderOptions = {}): string {
  const ctx: Ctx = { conv, registry: new ArtifactRegistry() };
  const out: string[] = [renderHeader(conv, opts.exportedAt ?? new Date())];
  for (const m of conv.messages) {
    out.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}:\n\n`);
    if (m.time) out.push(`> ${formatDateTime(m.time)}\n\n`);
    out.push(renderMessageBody(m, ctx));
  }
  return `${collapseBlankLines(out.join('')).trimEnd()}\n`;
}
