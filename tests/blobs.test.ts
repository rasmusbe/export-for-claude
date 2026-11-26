import { describe, expect, it } from 'vitest';
import { BlobAssembler, CHUNK_BYTES, base64ToBytes, bytesToBase64, chunkBytes } from '../src/extension/blobs';

function pseudoRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 123456789;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('blob transfer helpers', () => {
  it('round-trips base64 for edge sizes', () => {
    for (const n of [0, 1, 2, 3, 4, 100, 0x8000 - 1, 0x8000, 0x8000 + 1]) {
      const b = pseudoRandom(n);
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    }
  });

  it('round-trips a multi-MB buffer through chunks and the assembler', async () => {
    const data = pseudoRandom(13 * 1024 * 1024 + 5);
    const chunks = chunkBytes(data);
    expect(chunks.length).toBe(3);
    expect(CHUNK_BYTES % 3).toBe(0);
    const asm = new BlobAssembler();
    // Arrive out of order.
    for (const i of [2, 0, 1]) {
      const b64 = bytesToBase64(chunks[i]);
      expect(b64.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      asm.add(i, b64);
    }
    expect(asm.isComplete(3)).toBe(true);
    const joined = new Uint8Array(await new Blob(asm.finish(3) as BlobPart[]).arrayBuffer());
    expect(joined.length).toBe(data.length);
    expect(Buffer.compare(joined, data)).toBe(0);
  });

  it('chunks respect the size and keep empty input as one chunk', () => {
    expect(chunkBytes(new Uint8Array(0)).length).toBe(1);
    expect(chunkBytes(new Uint8Array(10), 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunkBytes(new Uint8Array(8), 4).map((c) => c.length)).toEqual([4, 4]);
  });

  it('refuses to finish with a missing chunk and tolerates duplicates', () => {
    const asm = new BlobAssembler();
    asm.add(0, bytesToBase64(new Uint8Array([1])));
    asm.add(0, bytesToBase64(new Uint8Array([1])));
    expect(asm.isComplete(2)).toBe(false);
    expect(() => asm.finish(2)).toThrow();
    expect(() => asm.add(-1, '')).toThrow();
  });

  it('keeps UTF-8 text intact', () => {
    const text = 'Åäö 日本語 😀\n'.repeat(1000);
    const back = new TextDecoder().decode(base64ToBytes(bytesToBase64(new TextEncoder().encode(text))));
    expect(back).toBe(text);
  });
});
