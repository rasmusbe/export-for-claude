// Pick the visible branch of a chat tree and merge same-sender neighbours.

export interface RawChatMessage {
  uuid: string;
  sender: string;
  parent_message_uuid?: string | null;
  content?: unknown[];
  files_v2?: unknown[];
  files?: unknown[];
  attachments?: unknown[];
  sync_sources?: unknown[];
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * Walk from `leafUuid` to the root via `parent_message_uuid`.
 *
 * - No leaf: the whole array, in order.
 * - A message on the path without a parent (legacy data): everything before it
 *   in array order is prepended and the walk stops.
 * - A leaf or parent that is missing from the array ends the walk.
 */
export function selectBranch<T extends RawChatMessage>(messages: T[], leafUuid?: string | null): T[] {
  if (!leafUuid) return [...messages];
  const byId = new Map(messages.map((m) => [m.uuid, m]));
  const path: T[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = leafUuid;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const msg = byId.get(cur);
    if (!msg) break;
    path.unshift(msg);
    if (!msg.parent_message_uuid) {
      const idx = messages.indexOf(msg);
      path.unshift(...messages.slice(0, idx));
      break;
    }
    cur = msg.parent_message_uuid;
  }
  // A leaf that does not exist gives an empty path; fall back to everything.
  return path.length ? path : [...messages];
}

const MERGED_LISTS = ['content', 'files_v2', 'files', 'attachments', 'sync_sources'] as const;

/** Merge consecutive messages from the same sender into one. Inputs are not mutated. */
export function mergeSameSender<T extends RawChatMessage>(messages: T[]): T[] {
  const out: T[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.sender && prev.sender === msg.sender) {
      const merged = { ...prev } as T;
      for (const key of MERGED_LISTS) {
        (merged as any)[key] = [...((prev[key] as unknown[]) ?? []), ...((msg[key] as unknown[]) ?? [])];
      }
      if (msg.updated_at) merged.updated_at = msg.updated_at;
      out[out.length - 1] = merged;
    } else {
      out.push({ ...msg });
    }
  }
  return out;
}
