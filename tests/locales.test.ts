import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const LOCALES = join(ROOT, 'public', '_locales');

type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
const load = (lang: string): Messages => JSON.parse(readFileSync(join(LOCALES, lang, 'messages.json'), 'utf8'));
const en = load('en');
const sv = load('sv');

/** Placeholder names a message text refers to (`$name$`), and those it declares. */
const used = (m: Messages[string]) => [...m.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((x) => x[1].toLowerCase()).sort();
const declared = (m: Messages[string]) => Object.keys(m.placeholders ?? {}).map((x) => x.toLowerCase()).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === '_locales') return [];
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|html|json)$/.test(name) ? [p] : [];
  });
}

/** Message keys referenced from src/ and public/. */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'public'))]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:getMessage|\bt)\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(m[1]);
    for (const m of text.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) keys.add(m[1]);
  }
  return keys;
}

describe('locales', () => {
  it('en and sv have the same keys', () => {
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort());
  });

  it('en and sv use the same placeholders, and all are declared', () => {
    for (const key of Object.keys(en)) {
      expect(used(sv[key]), key).toEqual(used(en[key]));
      expect(declared(sv[key]), key).toEqual(declared(en[key]));
      expect(declared(en[key]), key).toEqual(used(en[key]));
      // $1..$9 substitutions line up as well.
      for (const name of Object.keys(en[key].placeholders ?? {})) {
        expect(sv[key].placeholders?.[name]?.content, `${key}.${name}`).toBe(en[key].placeholders![name].content);
      }
    }
  });

  it('every message has text', () => {
    for (const lang of [en, sv]) for (const [key, m] of Object.entries(lang)) expect(m.message.trim(), key).not.toBe('');
  });

  it('every key used in src/ and public/ exists in both locales', () => {
    const keys = usedKeys();
    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      expect(en, key).toHaveProperty(key);
      expect(sv, key).toHaveProperty(key);
    }
  });

  it('every message is used somewhere', () => {
    const keys = usedKeys();
    for (const key of Object.keys(en)) expect(keys.has(key), key).toBe(true);
  });

  it('the manifest declares en as the default locale', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8'));
    expect(manifest.default_locale).toBe('en');
  });
});
