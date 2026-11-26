// Sender side of the byte transfer: content script or popup -> offscreen document.

import { CHUNK_BYTES, bytesToBase64, chunkBytes } from './blobs';
import { t } from './i18n';
import type { BlobChunkMessage, OffscreenEnsureMessage, OkResponse } from './messages';

export interface Upload {
  uploadId: string;
  count: number;
  mime: string;
}

async function send<T extends OkResponse>(msg: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as T | undefined;
  if (!res?.ok) throw new Error(res && !res.ok ? res.message : t('errorNoBackground'));
  return res;
}

/** Hand `bytes` to the offscreen document, which keeps them until the background worker asks for the Blob. */
export async function uploadBytes(bytes: Uint8Array, mime: string, chunkSize = CHUNK_BYTES): Promise<Upload> {
  await send({ type: 'export-for-claude:offscreen-ensure' } satisfies OffscreenEnsureMessage);
  const uploadId = crypto.randomUUID();
  const chunks = chunkBytes(bytes, chunkSize);
  for (let index = 0; index < chunks.length; index++) {
    await send({ type: 'export-for-claude:blob-chunk', uploadId, index, data: bytesToBase64(chunks[index]) } satisfies BlobChunkMessage);
  }
  return { uploadId, count: chunks.length, mime };
}
