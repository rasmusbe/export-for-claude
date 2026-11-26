// Small formatting helpers: dates, filenames, text clean-up.

const pad = (n: number) => String(n).padStart(2, '0');

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `YYYY-MM-DD HH:MM:SS` in local time, zero padded. Empty string for bad input. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `YYYY-MM-DD` in local time. Empty string for bad input. */
export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MAX_TITLE_LENGTH = 120;

/** Make a conversation title safe as a file name on macOS, Windows and Linux. */
export function sanitizeTitle(title: string): string {
  let s = (title || '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Leading dots hide files, trailing dots and spaces are stripped by Windows.
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s.length > MAX_TITLE_LENGTH) s = s.slice(0, MAX_TITLE_LENGTH).replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s || 'Claude';
}

/** `YYYY-MM-DD Title.ext`, or `Title.ext` without a usable date. */
export function buildFilename(createdAt: string | null, title: string, ext: 'md' | 'json'): string {
  const date = formatDate(createdAt);
  const name = sanitizeTitle(title);
  return `${date ? `${date} ` : ''}${name}.${ext}`;
}

/** Remove every `<system-reminder>…</system-reminder>` block. */
export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

export function stripUploadedFiles(text: string): string {
  return text.replace(/<uploaded_files>[\s\S]*?<\/uploaded_files>\s*/g, '');
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Apply `fn` to the parts of a Markdown document that are outside fenced code
 * blocks, leaving the fences and their content untouched.
 */
export function mapOutsideFences(md: string, fn: (s: string) => string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;
  const flushProse = () => {
    if (prose.length) out.push(fn(prose.join('\n')));
    prose = [];
  };
  for (const line of lines) {
    const m = line.match(FENCE_RE);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      flushProse();
      out.push(line);
      fence = { char: m[1][0], len: m[1].length };
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join('\n');
}

/** Collapse runs of 3+ line breaks (blank lines) outside code fences to one blank line. */
export function collapseBlankLines(md: string): string {
  return mapOutsideFences(md, (s) => s.replace(/(\n[ \t]*){3,}/g, '\n\n'));
}

/**
 * Model output sometimes nests fences of equal length (a ```markdown block that
 * itself contains ``` blocks). Lengthen the outer fence so it still renders.
 */
export function fixNestedFences(text: string): string {
  const lines = text.split('\n');
  type F = { idx: number; indent: string; char: string; len: number; info: string; bare: boolean };
  const fences: F[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (m) fences.push({ idx, indent: m[1], char: m[2][0], len: m[2].length, info: m[3], bare: m[3].trim() === '' });
  });
  if (fences.length < 2) return text;
  let i = 0;
  while (i < fences.length) {
    const open = fences[i];
    if (!open.bare) {
      let depth = 1;
      let innerMax = 0;
      let close = -1;
      for (let j = i + 1; j < fences.length; j++) {
        const f = fences[j];
        if (f.char !== open.char) continue;
        if (f.bare) {
          depth--;
          if (depth === 0) {
            close = j;
            break;
          }
        } else {
          depth++;
        }
        innerMax = Math.max(innerMax, f.len);
      }
      if (close !== -1 && innerMax >= open.len) {
        const marker = open.char.repeat(innerMax + 1);
        lines[open.idx] = `${open.indent}${marker}${open.info}`;
        lines[fences[close].idx] = `${fences[close].indent}${marker}`;
        i = close + 1;
        continue;
      }
    }
    // Skip to this fence's ordinary closer.
    let j = i + 1;
    while (j < fences.length && !(fences[j].char === open.char && fences[j].len >= open.len && fences[j].bare)) j++;
    i = j + 1;
  }
  return lines.join('\n');
}

/** A backtick fence longer than any backtick run inside `text` (at least `min`). */
export function fenceFor(text: string, min = 3): string {
  let len = min;
  for (const run of text.match(/`+/g) ?? []) len = Math.max(len, run.length + 1);
  return '`'.repeat(len);
}

export function absoluteClaudeUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url.startsWith('/') ? `https://claude.ai${url}` : url;
}

/** `/path?query` for a claude.ai URL or path, null for anything else. */
export function toClaudePath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.origin === 'https://claude.ai' ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD Title – files.zip`, or `Title – files.zip` without a usable date. */
export function buildZipFilename(createdAt: string | null, title: string, suffix = 'files.zip'): string {
  const date = formatDate(createdAt);
  return `${date ? `${date} ` : ''}${sanitizeTitle(title)} – ${suffix}`;
}

export function orgFileUrl(orgId: string | null, fileUuid: string | null | undefined): string | null {
  if (!orgId || !fileUuid) return null;
  return `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileUuid)}/contents`;
}

/** `/api/{org}/files/{uuid}/preview`: the downscaled webp of an uploaded image. */
export function orgPreviewPath(orgId: string | null, fileUuid: string | null | undefined): string | null {
  if (!orgId || !fileUuid) return null;
  return `/api/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileUuid)}/preview`;
}

/** Path of a file's original bytes. */
export function orgContentsPath(orgId: string, fileUuid: string): string {
  return `/api/organizations/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileUuid)}/contents`;
}
