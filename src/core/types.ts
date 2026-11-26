// Internal model shared by the chat and Cowork normalisers and the renderers.

export type Json = Record<string, any>;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  /** Last summary line only; the full thinking text is never kept. */
  summary: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Json | null;
  /** Human readable label the chat API attaches to some tool calls. */
  message?: string;
  hidden?: boolean;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  name?: string;
  content: unknown;
  isError?: boolean;
  /** Cowork only: the structured `tool_use_result` of the event. */
  toolUseResult?: unknown;
  hidden?: boolean;
}

export type Block = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ImageRef {
  name: string;
  url: string;
  /** Downscaled preview (webp), used when images are embedded in the PDF. */
  previewUrl?: string;
}

/** A file attached to a message (uploaded by the user, or made by Claude). */
export interface FileRef {
  name: string;
  kind: 'image' | 'document' | 'blob';
  fileUuid: string;
  /** claude.ai path of the downscaled preview, when the file has one (images). */
  previewPath: string | null;
  from: 'user' | 'assistant';
  /** ISO time the file was created; used as the file date in the zip. */
  createdAt: string | null;
}

export interface Paste {
  text: string;
}

export interface SyncSource {
  label: string;
  title: string;
  url: string;
}

export interface Message {
  role: 'user' | 'assistant';
  /** ISO timestamp of the last content in the message. */
  time: string | null;
  blocks: Block[];
  images: ImageRef[];
  /** Names of non-image attachments. */
  files: string[];
  /** The attached files that can be fetched, for the zip download. */
  uploads: FileRef[];
  pastes: Paste[];
  syncSources: SyncSource[];
}

export type ConversationKind = 'chat' | 'cowork';

export interface Conversation {
  kind: ConversationKind;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  link: string;
  orgId: string | null;
  /** Chat uuid, used for file download links. */
  conversationId: string | null;
  messages: Message[];
}

export function emptyMessage(role: Message['role'], time: string | null): Message {
  return { role, time, blocks: [], images: [], files: [], uploads: [], pastes: [], syncSources: [] };
}

export function messageIsEmpty(m: Message): boolean {
  return !m.blocks.length && !m.images.length && !m.files.length && !m.pastes.length && !m.syncSources.length;
}
