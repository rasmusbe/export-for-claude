import type { Http } from './api';
import { collectFiles, type DownloadFile } from './files';
import { buildFilename, buildZipFilename } from './format';
import { embedImages } from './images';
import { renderJson } from './json';
import { loadConversation, type LoadContext } from './loader';
import { renderMarkdown } from './markdown';
import { DEFAULT_ZIP_TEXTS, buildFilesZip, type MissingFile, type ZipTexts } from './zip';

export { ExportError, fetchHttp, type ErrorCode, type Http } from './api';
export { emptyHookState, type HookState, type LoadContext } from './loader';
export { parsePage } from './page';
export { DEFAULT_ZIP_TEXTS } from './zip';
export type { MissingFile, ZipTexts } from './zip';

export type ExportFormat = 'md' | 'json';

export interface ExportResult {
  title: string;
  filename: string;
  mime: string;
  content: string;
}

export interface ExportOptions {
  /** Markdown only: fetch images and embed them as data: URLs (for the PDF page). */
  inlineImages?: boolean;
}

export async function exportConversation(
  http: Http,
  ctx: LoadContext,
  format: ExportFormat,
  now: Date = new Date(),
  opts: ExportOptions = {},
): Promise<ExportResult> {
  let conv = await loadConversation(http, ctx);
  if (opts.inlineImages && format === 'md') conv = await embedImages(http, conv);
  const filename = buildFilename(conv.createdAt, conv.title, format);
  if (format === 'json') {
    return { title: conv.title, filename, mime: 'application/json', content: renderJson(conv, now) };
  }
  return { title: conv.title, filename, mime: 'text/markdown', content: renderMarkdown(conv, { exportedAt: now }) };
}

export interface FilesListing {
  zipFilename: string;
  files: DownloadFile[];
}

/** The files the zip download would contain. */
export async function listFiles(http: Http, ctx: LoadContext, texts: ZipTexts = DEFAULT_ZIP_TEXTS): Promise<FilesListing> {
  const conv = await loadConversation(http, ctx);
  return { zipFilename: buildZipFilename(conv.createdAt, conv.title, texts.zipSuffix), files: collectFiles(conv) };
}

export interface FilesZip {
  zipFilename: string;
  /** Null when no file could be fetched. */
  bytes: Uint8Array | null;
  total: number;
  missing: MissingFile[];
}

/** Load the conversation, fetch its files and zip them. */
export async function zipFiles(
  http: Http,
  ctx: LoadContext,
  onProgress?: (done: number, total: number) => void,
  texts: ZipTexts = DEFAULT_ZIP_TEXTS,
): Promise<FilesZip> {
  const { zipFilename, files } = await listFiles(http, ctx, texts);
  if (!files.length) return { zipFilename, bytes: null, total: 0, missing: [] };
  const r = await buildFilesZip(http, files, onProgress, texts);
  return { zipFilename, bytes: r.bytes, total: r.total, missing: r.missing };
}
