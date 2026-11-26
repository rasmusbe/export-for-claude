// Embed a conversation's images as data: URLs, so the print page does not need
// claude.ai cookies to show them.

import type { Http } from './api';
import { toClaudePath } from './format';
import { mapLimit } from './pool';
import type { Conversation } from './types';

function sniffMime(b: Uint8Array): string | null {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A copy of `conv` whose images carry data: URLs (preview size when there is
 * one). An image that cannot be fetched keeps its claude.ai URL.
 */
export async function embedImages(http: Http, conv: Conversation): Promise<Conversation> {
  const paths = new Set<string>();
  for (const m of conv.messages) {
    for (const img of m.images) {
      const p = toClaudePath(img.previewUrl || img.url);
      if (p) paths.add(p);
    }
  }
  const dataUrls = new Map<string, string>();
  await mapLimit([...paths], 3, async (path) => {
    try {
      const bytes = await http.getBytes(path);
      const mime = sniffMime(bytes);
      if (mime) dataUrls.set(path, `data:${mime};base64,${toBase64(bytes)}`);
    } catch {
      /* keep the claude.ai URL */
    }
  });
  return {
    ...conv,
    messages: conv.messages.map((m) => ({
      ...m,
      images: m.images.map((img) => {
        const p = toClaudePath(img.previewUrl || img.url);
        const data = p ? dataUrls.get(p) : undefined;
        return data ? { ...img, url: data } : img;
      }),
    })),
  };
}
