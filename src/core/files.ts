// Which files of a conversation can be downloaded, and how to fetch them.
//
// Included: files the user uploaded (images, PDFs, documents) and files Claude
// shared (chat `files` of assistant messages, `present_files` in normal chats,
// `SendUserFile` results in Cowork). Not included: tool screenshots, artifacts
// and pasted text.

import { orgContentsPath } from './format';
import type { Block, Conversation, FileRef, Json } from './types';

export interface FileSource {
  /** claude.ai path to GET. */
  path: string;
  /** Set when this source is not the original, e.g. `webp` for an image preview. */
  ext?: string;
}

export interface DownloadFile {
  name: string;
  /** Tried in order; the first that works is used. */
  sources: FileSource[];
  /** ISO time the file was created, if known; set as the date in the zip. */
  createdAt?: string | null;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function uploadSources(f: FileRef, orgId: string | null): FileSource[] {
  const sources: FileSource[] = [];
  // The original first. /contents gives the file as uploaded; /preview is a
  // downscaled webp (see DESIGN.md), so it is only a fallback for images.
  if (orgId) sources.push({ path: orgContentsPath(orgId, f.fileUuid) });
  if (f.kind === 'image' && f.previewPath) sources.push({ path: f.previewPath, ext: 'webp' });
  return sources;
}

function presentedPath(conv: Conversation, filePath: string): string | null {
  if (!conv.orgId || !conv.conversationId) return null;
  return (
    `/api/organizations/${encodeURIComponent(conv.orgId)}` +
    `/conversations/${encodeURIComponent(conv.conversationId)}/wiggle/download-file?path=${encodeURIComponent(filePath)}`
  );
}

function sharedFiles(blocks: Block[], conv: Conversation, createdAt: string | null): DownloadFile[] {
  const out: DownloadFile[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && conv.kind === 'chat' && b.name === 'present_files' && Array.isArray(b.input?.filepaths)) {
      for (const p of b.input.filepaths as unknown[]) {
        if (typeof p !== 'string' || !p) continue;
        const path = presentedPath(conv, p);
        if (path) out.push({ name: baseName(p), sources: [{ path }], createdAt });
      }
    } else if (b.type === 'tool_result' && conv.kind === 'cowork' && b.name === 'SendUserFile') {
      for (const a of ((b.toolUseResult as Json)?.attachments ?? []) as Json[]) {
        if (!a?.path || typeof a.file_uuid !== 'string' || !a.file_uuid || !conv.orgId) continue;
        out.push({ name: baseName(a.path), sources: [{ path: orgContentsPath(conv.orgId, a.file_uuid) }], createdAt });
      }
    }
  }
  return out;
}

/** Downloadable files in conversation order, without duplicates. */
export function collectFiles(conv: Conversation): DownloadFile[] {
  const seenUuids = new Set<string>();
  const files: DownloadFile[] = [];
  const addUuid = (f: DownloadFile, uuid: string) => {
    if (seenUuids.has(uuid)) return;
    seenUuids.add(uuid);
    files.push(f);
  };
  const wiggle: DownloadFile[] = [];
  for (const m of conv.messages) {
    for (const u of m.uploads) {
      const sources = uploadSources(u, conv.orgId);
      if (sources.length) addUuid({ name: u.name || u.fileUuid, sources, createdAt: u.createdAt }, u.fileUuid);
    }
    for (const f of sharedFiles(m.blocks, conv, m.time)) {
      const uuid = /\/files\/([^/]+)\/contents$/.exec(f.sources[0].path)?.[1];
      if (uuid) addUuid(f, decodeURIComponent(uuid));
      else wiggle.push(f);
    }
  }
  // A file may be listed on the message and also presented with a path; keep
  // the copy with a file id and drop a path copy with the same name.
  const names = new Set(files.map((f) => f.name.toLowerCase()));
  const seenPaths = new Set<string>();
  for (const f of wiggle) {
    const key = f.sources[0].path;
    if (names.has(f.name.toLowerCase()) || seenPaths.has(key)) continue;
    seenPaths.add(key);
    files.push(f);
  }
  return files;
}
