// Pure helpers for moving binary data through chrome.runtime messages, which are
// JSON-serialised (no ArrayBuffer). Bytes travel as base64 in chunks and are
// reassembled in the offscreen document. No chrome.* here, so it runs in node tests.

/** Raw bytes per message. A multiple of 3, so every chunk but the last has no base64 padding (8 MiB as base64). */
export const CHUNK_BYTES = 6 * 1024 * 1024;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Split into pieces of at most `size` bytes. Empty input gives one empty chunk, so the receiver always gets something. */
export function chunkBytes(bytes: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  if (bytes.length === 0) return [bytes];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** Collects base64 chunks by index (they may arrive in any order) and joins them. */
export class BlobAssembler {
  private parts = new Map<number, Uint8Array>();

  add(index: number, b64: string): void {
    if (!Number.isInteger(index) || index < 0) throw new Error('Ogiltigt delnummer.');
    this.parts.set(index, base64ToBytes(b64));
  }

  isComplete(count: number): boolean {
    if (this.parts.size !== count) return false;
    for (let i = 0; i < count; i++) if (!this.parts.has(i)) return false;
    return true;
  }

  /** The chunks in order. Throws if any is missing. */
  finish(count: number): Uint8Array[] {
    if (!this.isComplete(count)) throw new Error('The file did not arrive in full.');
    return Array.from({ length: count }, (_, i) => this.parts.get(i)!);
  }
}
