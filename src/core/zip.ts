// Fetch the files and pack them into one zip (fflate).

import { zipSync, type Zippable } from 'fflate';
import { ExportError, type ErrorCode, type Http } from './api';
import type { DownloadFile } from './files';
import { mapLimit } from './pool';

const CONCURRENCY = 3;

/** Formats that are already compressed: stored as they are. */
const STORE_EXT = /\.(png|jpe?g|gif|webp|heic|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp3|m4a|aac|ogg|mp4|mov|webm|docx|xlsx|pptx)$/i;

export interface MissingFile {
  name: string;
  reason: string;
}

export interface ZipResult {
  /** Null when no file could be fetched. */
  bytes: Uint8Array | null;
  total: number;
  added: number;
  missing: MissingFile[];
}

/**
 * Texts that end up inside the exported zip. The core is language-neutral: the
 * extension passes localised strings, these English ones are the default.
 */
export interface ZipTexts {
  /** Zip file name suffix after the title, e.g. `files.zip`. */
  zipSuffix: string;
  /** Name of the list of files that could not be fetched. */
  missingFileName: string;
  /** First line of that list. */
  missingHeading: string;
  reasonNotFound: string;
  reasonNoAccess: string;
  reasonRateLimited: string;
  reasonNetwork: string;
  reasonUnknown: string;
}

export const DEFAULT_ZIP_TEXTS: ZipTexts = {
  zipSuffix: 'files.zip',
  missingFileName: 'missing.txt',
  missingHeading: 'These files could not be fetched:',
  reasonNotFound: 'not found',
  reasonNoAccess: 'no access',
  reasonRateLimited: 'rate limited',
  reasonNetwork: 'network error',
  reasonUnknown: 'unknown error',
};

export function reasonFor(e: unknown, texts: ZipTexts = DEFAULT_ZIP_TEXTS): string {
  if (!(e instanceof ExportError)) return texts.reasonUnknown;
  const reasons: Record<ErrorCode, string> = {
    not_found: texts.reasonNotFound,
    not_logged_in: texts.reasonNoAccess,
    rate_limited: texts.reasonRateLimited,
    network: texts.reasonNetwork,
    not_a_chat: texts.reasonUnknown,
    unknown: texts.reasonUnknown,
  };
  return reasons[e.code];
}

/** A name that is safe as a single zip entry on every OS. */
export function safeEntryName(name: string): string {
  let s = (name || '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').trim();
  s = s.replace(/[.\s]+$/, '');
  if (!s || /^\.+$/.test(s)) return 'file';
  return s;
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

export function withExtension(name: string, ext: string): string {
  const [stem] = splitExt(name);
  return `${stem}.${ext}`;
}

/** `a.txt` taken → `a (2).txt`, `a (3).txt`. Compared case-insensitively. */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  const [stem, ext] = splitExt(name);
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Zip entry date for an ISO time. Zip stores local time from 1980 on, so
 * anything unparsable or earlier gives undefined (fflate then uses now).
 */
export function zipDate(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 1980 ? undefined : d;
}

export function missingFileText(missing: MissingFile[], texts: ZipTexts = DEFAULT_ZIP_TEXTS): string {
  const lines = missing.map((m) => `- ${m.name} (${m.reason})`);
  return `${texts.missingHeading}\n\n${lines.join('\n')}\n`;
}

interface Fetched {
  file: DownloadFile;
  data?: Uint8Array;
  ext?: string;
  error?: unknown;
}

async function fetchFile(http: Http, file: DownloadFile): Promise<Fetched> {
  let firstError: unknown;
  for (const source of file.sources) {
    try {
      return { file, data: await http.getBytes(source.path), ext: source.ext };
    } catch (e) {
      firstError ??= e;
      if (e instanceof ExportError && e.code === 'rate_limited') break;
    }
  }
  return { file, error: firstError };
}

/**
 * Fetch `files` (three at a time) and zip what worked. Files that could not be
 * fetched are listed in the missing-files list (`texts.missingFileName`) inside the zip and in `missing`.
 */
export async function buildFilesZip(
  http: Http,
  files: DownloadFile[],
  onProgress?: (done: number, total: number) => void,
  texts: ZipTexts = DEFAULT_ZIP_TEXTS,
): Promise<ZipResult> {
  let done = 0;
  const fetched = await mapLimit(files, CONCURRENCY, async (file) => {
    const r = await fetchFile(http, file);
    onProgress?.(++done, files.length);
    return r;
  });

  const taken = new Set<string>();
  const zippable: Zippable = {};
  const missing: MissingFile[] = [];
  for (const f of fetched) {
    if (!f.data) {
      missing.push({ name: f.file.name, reason: reasonFor(f.error, texts) });
      continue;
    }
    let name = safeEntryName(f.file.name);
    if (f.ext) name = withExtension(name, f.ext);
    name = uniqueName(name, taken);
    const mtime = zipDate(f.file.createdAt);
    zippable[name] = [f.data, { level: STORE_EXT.test(name) ? 0 : 6, ...(mtime ? { mtime } : {}) }];
  }
  const added = Object.keys(zippable).length;
  if (!added) return { bytes: null, total: files.length, added: 0, missing };
  if (missing.length) {
    zippable[uniqueName(texts.missingFileName, taken)] = new TextEncoder().encode(missingFileText(missing, texts));
  }
  return { bytes: zipSync(zippable), total: files.length, added, missing };
}
