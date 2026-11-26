// Message shapes between the extension parts.

import { t } from './i18n';
import type { Upload } from './upload';
import type { ErrorCode, ExportFormat, HookState, MissingFile } from '../core';

export const HOOK_SOURCE = 'export-for-claude-hook';
export const CS_SOURCE = 'export-for-claude-cs';

/** window.postMessage between the MAIN-world hook and the content script. */
export type HookMessage =
  | { source: typeof CS_SOURCE; type: 'get-state'; nonce: string }
  | { source: typeof HOOK_SOURCE; type: 'state'; nonce: string; state: HookState };

/** chrome.tabs.sendMessage to the content script. */
export interface ExportRequest {
  type: 'export-for-claude:export';
  format: ExportFormat;
  /** Embed images as data: URLs (the print page cannot rely on cookies). */
  inlineImages?: boolean;
}

export type ExportResponse =
  | { ok: true; title: string; filename: string; mime: string; content: string }
  | { ok: false; code: ErrorCode; message: string };

/** chrome.tabs.sendMessage to the content script: the downloadable files. */
export type FilesAction =
  | { action: 'count' }
  | { action: 'zip' };

export type FilesRequest = { type: 'export-for-claude:files' } & FilesAction;

export type FilesResponse =
  | { ok: true; action: 'count'; count: number }
  | {
      ok: true;
      action: 'zip';
      filename: string;
      /** The zip, already uploaded to the offscreen document; the download request names it. */
      upload: Upload;
      total: number;
      missing: MissingFile[];
    }
  | { ok: false; code: ErrorCode | 'no_files'; message: string };

/** chrome.runtime.sendMessage from the content script while files are fetched. */
export interface FilesProgress {
  type: 'export-for-claude:files-progress';
  done: number;
  total: number;
}

/** Reply shape shared by the byte-transfer messages. */
export type OkResponse = { ok: true } | { ok: false; message: string };

/** To the background worker: make sure the offscreen document exists. */
export interface OffscreenEnsureMessage {
  type: 'export-for-claude:offscreen-ensure';
}

/** To the offscreen document: one base64 piece (<= 8 MiB) of an upload. */
export interface BlobChunkMessage {
  type: 'export-for-claude:blob-chunk';
  uploadId: string;
  index: number;
  data: string;
}

/** Background -> offscreen: join the chunks into a Blob and answer with its URL. */
export interface BlobFinishMessage {
  type: 'export-for-claude:blob-finish';
  uploadId: string;
  count: number;
  mime: string;
}
export type BlobFinishResponse = { ok: true; url: string } | { ok: false; message: string };

/** Background -> offscreen: revoke a Blob URL; `idle` says nothing else is held. */
export interface BlobRevokeMessage {
  type: 'export-for-claude:blob-revoke';
  url: string;
}
export type BlobRevokeResponse = { ok: true; idle: boolean } | { ok: false; message: string };

/** Popup -> background worker: save an uploaded file. */
export interface DownloadRequest {
  type: 'export-for-claude:download';
  filename: string;
  uploadId: string;
  count: number;
  mime: string;
}

export type DownloadResponse = OkResponse;

/** Localised error text shown in the popup and the print page. */
export function errorText(code: ErrorCode | 'no_content_script'): string {
  switch (code) {
    case 'not_logged_in':
      return t('errorNotLoggedIn');
    case 'not_found':
      return t('errorNotFound');
    case 'rate_limited':
      return t('errorRateLimited');
    case 'network':
      return t('errorNetwork');
    case 'not_a_chat':
      return t('errorNotAChat');
    case 'no_content_script':
      return t('errorNoContentScript');
    default:
      return t('errorUnknown');
  }
}

const noScript = () => ({ ok: false, code: 'unknown', message: errorText('no_content_script') }) as const;

/** Ask the content script in `tabId` about the conversation's downloadable files. */
export async function requestFiles(tabId: number, req: FilesAction): Promise<FilesResponse> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'export-for-claude:files', ...req } as FilesRequest)) as
      | FilesResponse
      | undefined;
    return res ?? noScript();
  } catch {
    return noScript();
  }
}

/** Ask the content script in `tabId` for an export. */
export async function requestExport(tabId: number, format: ExportFormat, inlineImages = false): Promise<ExportResponse> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'export-for-claude:export', format, inlineImages } satisfies ExportRequest)) as
      | ExportResponse
      | undefined;
    // No answer or no content script: the tab was opened before the extension loaded.
    return res ?? noScript();
  } catch {
    return noScript();
  }
}
