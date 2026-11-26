// Work out what kind of claude.ai page is open.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string | null | undefined): s is string {
  return !!s && UUID_RE.test(s);
}

/** Cowork / Claude Code remote chats use UUIDv8 ids (version nibble at index 14). */
export function isUuidV8(s: string): boolean {
  return isUuid(s) && s[14] === '8';
}

export type PageRef =
  | { kind: 'chat'; id: string }
  | { kind: 'share'; id: string }
  | { kind: 'new' }
  | { kind: 'other' };

export function parsePage(href: string): PageRef {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: 'other' };
  }
  if (url.hostname !== 'claude.ai') return { kind: 'other' };
  const parts = url.pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (parts[0] === 'chat' && isUuid(last)) return { kind: 'chat', id: last.toLowerCase() };
  if (parts[0] === 'share' && isUuid(last)) return { kind: 'share', id: last.toLowerCase() };
  if (parts[0] === 'new') return { kind: 'new' };
  return { kind: 'other' };
}
