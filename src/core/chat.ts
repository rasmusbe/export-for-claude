// Normalise the claude.ai chat API (normal, incognito and shared chats).

import { mergeSameSender, selectBranch, type RawChatMessage } from './branch';
import { absoluteClaudeUrl, stripSystemReminders, toClaudePath } from './format';
import { emptyMessage, type Block, type Conversation, type Json, type Message, type SyncSource } from './types';

export interface NormaliseChatOptions {
  link: string;
  orgId: string | null;
  conversationId: string | null;
}

/** Accepts a chat conversation or a chat snapshot (shared chat). */
export function normaliseChat(data: Json, opts: NormaliseChatOptions): Conversation {
  const raw: RawChatMessage[] = Array.isArray(data.chat_messages) ? data.chat_messages : [];
  const branch = mergeSameSender(selectBranch(raw, data.current_leaf_message_uuid));
  const messages = branch.map(toMessage);
  markHiddenArtifactUpdates(messages);
  return {
    kind: 'chat',
    title: data.name || data.snapshot_name || 'Claude',
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
    link: opts.link,
    orgId: opts.orgId,
    conversationId: opts.conversationId,
    messages,
  };
}

function toMessage(raw: RawChatMessage): Message {
  const role = raw.sender === 'human' ? 'user' : 'assistant';
  const msg = emptyMessage(role, raw.updated_at ?? raw.created_at ?? null);

  const files = (raw.files_v2?.length ? raw.files_v2 : raw.files ?? []) as Json[];
  for (const f of files) {
    if (f?.file_kind === 'image') msg.images.push({ name: f.file_name || '', url: absoluteClaudeUrl(f.preview_url) });
    else if (f?.file_kind === 'document' || f?.file_kind === 'blob') msg.files.push(f.file_name || '');
    if ((f?.file_kind === 'image' || f?.file_kind === 'document' || f?.file_kind === 'blob') && typeof f.file_uuid === 'string' && f.file_uuid) {
      msg.uploads.push({
        name: f.file_name || '',
        kind: f.file_kind,
        fileUuid: f.file_uuid,
        previewPath: toClaudePath(f.preview_url),
        from: role,
        createdAt: f.created_at ?? raw.created_at ?? null,
      });
    }
  }

  for (const a of (raw.attachments ?? []) as Json[]) {
    const isPaste =
      !(a?.file_name ?? '').trim() &&
      String(a?.file_type ?? '').toLowerCase() === 'txt' &&
      typeof a?.extracted_content === 'string' &&
      a.extracted_content.length > 0;
    if (isPaste) msg.pastes.push({ text: a.extracted_content });
    else msg.files.push(a?.file_name || '');
  }

  for (const s of (raw.sync_sources ?? []) as Json[]) {
    const src = syncSource(s);
    if (src) msg.syncSources.push(src);
  }

  for (const b of (raw.content ?? []) as Json[]) {
    const block = toBlock(b, role);
    if (block) msg.blocks.push(block);
  }
  return msg;
}

function toBlock(b: Json, role: Message['role']): Block | null {
  switch (b?.type) {
    case 'text': {
      const text = role === 'user' ? stripSystemReminders(b.text ?? '') : (b.text ?? '');
      return { type: 'text', text };
    }
    case 'thinking': {
      const summaries = Array.isArray(b.summaries) ? b.summaries : [];
      const summary = summaries.length ? String(summaries[summaries.length - 1]?.summary ?? '') : '';
      return { type: 'thinking', summary: summary.trim() };
    }
    case 'tool_use':
      return { type: 'tool_use', id: b.id ?? '', name: b.name ?? 'unknown', input: b.input ?? null, message: b.message || undefined };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: b.tool_use_id ?? '',
        name: b.name,
        content: b.content,
        isError: !!b.is_error,
      };
    default:
      return null; // token_budget and unknown block types
  }
}

function syncSource(s: Json): SyncSource | null {
  if (s?.type === 'github') {
    const owner = s.config?.owner;
    const repo = s.config?.repo;
    if (owner && repo) return { label: 'GitHub', title: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
  } else if (s?.type === 'gdrive') {
    const title = s.status?.extra;
    const uri = s.config?.uri;
    if (title && uri) return { label: 'Google Drive', title, url: `https://docs.google.com/document/d/${uri}` };
  } else if (s?.type === 'mcpres') {
    const r = s.config?.resource;
    if (r?.name && r?.uri) {
      const label = String(r.mimeType ?? '').startsWith('application/vnd.google-apps') ? 'Google Drive' : 'MCP Resource';
      return { label, title: r.name, url: r.uri };
    }
  }
  return null;
}

function isOkResult(b: Block | undefined): boolean {
  if (b?.type !== 'tool_result' || !Array.isArray(b.content) || b.content.length !== 1) return false;
  const c = b.content[0] as Json;
  return c?.type === 'text' && c.text === 'OK';
}

function isArtifactUpdate(b: Block | undefined): boolean {
  return b?.type === 'tool_use' && b.input?.command === 'update';
}

/**
 * Artifact edits often come as a series of `update` + "OK" pairs. Only the last
 * pair in a series is shown (it carries the final version); earlier pairs are
 * hidden. A single thinking block between pairs does not break a series.
 */
export function markHiddenArtifactUpdates(messages: Message[]): void {
  for (const m of messages) {
    const bs = m.blocks;
    const pairStarts: number[] = [];
    for (let i = 0; i < bs.length - 1; i++) {
      if (isArtifactUpdate(bs[i]) && isOkResult(bs[i + 1])) {
        pairStarts.push(i);
        i++;
      }
    }
    for (let k = 0; k < pairStarts.length - 1; k++) {
      const a = pairStarts[k];
      const next = pairStarts[k + 1];
      const gap = bs.slice(a + 2, next);
      const adjacent = gap.length === 0 || (gap.length === 1 && gap[0].type === 'thinking');
      if (adjacent) {
        (bs[a] as { hidden?: boolean }).hidden = true;
        (bs[a + 1] as { hidden?: boolean }).hidden = true;
      }
    }
  }
}
