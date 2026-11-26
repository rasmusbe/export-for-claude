import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE = join(__dirname, '..', 'fixtures', 'private');

/** Load a private fixture, or null when it is not on this machine. */
export function loadPrivate<T = any>(name: string): T | null {
  const p = join(PRIVATE, name);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  return (name.endsWith('.json') ? JSON.parse(text) : text) as T;
}

/** Minimal line diff (LCS) returning removed (-) and added (+) lines. */
export function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${i + 1}: ${a[i++]}`);
    else out.push(`+${j + 1}: ${b[j++]}`);
  }
  while (i < n) out.push(`-${i + 1}: ${a[i++]}`);
  while (j < m) out.push(`+${j + 1}: ${b[j++]}`);
  return out;
}
