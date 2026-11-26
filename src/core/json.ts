import { renderMessages } from './markdown';
import type { Conversation } from './types';

export interface ExportJson {
  metadata: { title: string; created: string | null; updated: string | null; exported: string; link: string };
  messages: { role: 'user' | 'assistant'; time: string | null; markdown: string }[];
}

/** Timestamps are ISO 8601 (UTC) as returned by claude.ai; `exported` is generated. */
export function buildJson(conv: Conversation, exportedAt: Date = new Date()): ExportJson {
  return {
    metadata: {
      title: conv.title,
      created: conv.createdAt,
      updated: conv.updatedAt,
      exported: exportedAt.toISOString(),
      link: conv.link,
    },
    messages: renderMessages(conv),
  };
}

export function renderJson(conv: Conversation, exportedAt: Date = new Date()): string {
  return `${JSON.stringify(buildJson(conv, exportedAt), null, 2)}\n`;
}
