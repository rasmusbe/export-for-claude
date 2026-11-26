// Normalise Cowork / Claude Code remote session events into the internal model.

import { orgFileUrl, orgPreviewPath, stripSystemReminders, stripUploadedFiles } from './format';
import { emptyMessage, messageIsEmpty, type Conversation, type Json, type Message } from './types';

export interface CoworkSession {
  title?: string;
  created_at?: string;
  last_event_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface CoworkEvent {
  event_id?: string;
  event_type?: string;
  source?: string;
  sequence_num?: string | number;
  created_at?: string;
  payload?: Json;
}

export interface NormaliseCoworkOptions {
  link: string;
  orgId: string | null;
  conversationId: string | null;
}

/** The session endpoint wraps the session in `response_shape`. */
export function unwrapSession(json: Json): CoworkSession {
  return (json?.response_shape ?? json ?? {}) as CoworkSession;
}

export function sortEvents(events: CoworkEvent[]): CoworkEvent[] {
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = e.event_id ?? `seq:${e.sequence_num}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num));
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: Json) => b?.type === 'text' && b.text)
    .map((b: Json) => b.text as string)
    .join('\n\n');
}

export function normaliseCowork(
  sessionJson: Json,
  events: CoworkEvent[],
  opts: NormaliseCoworkOptions,
): Conversation {
  const session = unwrapSession(sessionJson);
  return {
    kind: 'cowork',
    title: session.title || 'Claude',
    createdAt: session.created_at ?? null,
    updatedAt: session.last_event_at ?? session.updated_at ?? null,
    link: opts.link,
    orgId: opts.orgId,
    conversationId: opts.conversationId,
    messages: coworkMessages(events, opts.orgId),
  };
}

/**
 * Build messages from the event stream.
 *
 * - User turns are `client`/`user` events; consecutive ones form one message.
 * - Everything else belongs to the assistant turn: text and tool calls from
 *   `worker`/`assistant` events, tool results from `worker`/`user` events.
 * - Thinking is not shown for Cowork (it carries no summaries here).
 * - Subagent events (`payload.parent_tool_use_id` set) are skipped entirely, so
 *   a subagent's text is never presented as the main assistant's answer.
 * - A message's time is the time of its last content.
 */
export function coworkMessages(events: CoworkEvent[], orgId: string | null): Message[] {
  const out: Message[] = [];
  const toolNames = new Map<string, string>();
  let cur: Message | null = null;
  let lastWasUser = false;

  const flush = () => {
    if (cur && !messageIsEmpty(cur)) out.push(cur);
    cur = null;
  };

  for (const ev of sortEvents(events)) {
    const p = ev.payload ?? {};
    if (p.parent_tool_use_id) continue;
    const at = ev.created_at ?? null;

    if (ev.source === 'client' && ev.event_type === 'user' && p.message?.role === 'user') {
      if (!(cur && (cur as Message).role === 'user' && lastWasUser)) {
        flush();
        cur = emptyMessage('user', at);
      }
      const msg = cur as Message;
      const text = stripSystemReminders(stripUploadedFiles(userText(p.message.content))).trim();
      if (text) {
        msg.blocks.push({ type: 'text', text });
        msg.time = at;
      }
      for (const f of (p.file_attachments ?? []) as Json[]) {
        if (!f?.file_name) continue;
        if (f.is_image) {
          const preview = orgPreviewPath(orgId, f.file_uuid);
          msg.images.push({
            name: f.file_name,
            url: orgFileUrl(orgId, f.file_uuid) ?? '',
            previewUrl: preview ? `https://claude.ai${preview}` : undefined,
          });
        } else msg.files.push(f.file_name);
        if (typeof f.file_uuid === 'string' && f.file_uuid) {
          msg.uploads.push({
            name: f.file_name,
            kind: f.is_image ? 'image' : 'blob',
            fileUuid: f.file_uuid,
            previewPath: f.is_image ? orgPreviewPath(orgId, f.file_uuid) : null,
            from: 'user',
            createdAt: at,
          });
        }
      }
      lastWasUser = true;
      continue;
    }

    lastWasUser = false;
    if (!cur || (cur as Message).role !== 'assistant') {
      flush();
      cur = emptyMessage('assistant', at);
    }
    const msg = cur as Message;

    if (ev.source === 'worker' && ev.event_type === 'assistant') {
      for (const b of (p.message?.content ?? []) as Json[]) {
        if (b?.type === 'text' && b.text) {
          msg.blocks.push({ type: 'text', text: b.text });
          msg.time = at;
        } else if (b?.type === 'tool_use') {
          toolNames.set(b.id, b.name);
          msg.blocks.push({ type: 'tool_use', id: b.id ?? '', name: b.name ?? 'unknown', input: b.input ?? null });
          msg.time = at;
        }
      }
    } else if (ev.source === 'worker' && ev.event_type === 'user') {
      for (const b of (p.message?.content ?? []) as Json[]) {
        if (b?.type !== 'tool_result') continue;
        msg.blocks.push({
          type: 'tool_result',
          toolUseId: b.tool_use_id ?? '',
          name: toolNames.get(b.tool_use_id),
          content: b.content,
          isError: !!b.is_error,
          toolUseResult: p.tool_use_result,
        });
        msg.time = at;
      }
    }
  }
  flush();
  return out;
}
