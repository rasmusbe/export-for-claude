// Replay artifact tool calls (create / update / rewrite) so each output shows
// the full artifact at that version.

import { fenceFor } from './format';
import type { Json } from './types';

export interface Artifact {
  id: string;
  title: string;
  type: string;
  language?: string;
  content: string;
  version: number;
  citations?: Json[];
}

export class ArtifactRegistry {
  private items = new Map<string, Artifact>();

  get(id: string): Artifact | undefined {
    return this.items.get(id);
  }

  create(input: Json, content: string = input.content ?? ''): Artifact {
    const prev = this.items.get(input.id);
    const a: Artifact = {
      id: input.id,
      title: input.title ?? prev?.title ?? '',
      type: input.type ?? prev?.type ?? '',
      language: input.language ?? prev?.language,
      content,
      version: (prev?.version ?? 0) + 1,
      citations: input.md_citations,
    };
    this.items.set(a.id, a);
    return a;
  }

  update(input: Json): Artifact {
    const prev = this.items.get(input.id)!;
    const oldStr: string = input.old_str ?? '';
    const newStr: string = input.new_str ?? '';
    const content = oldStr && prev.content.includes(oldStr) ? prev.content.replace(oldStr, () => newStr) : prev.content;
    const a = { ...prev, content, version: prev.version + 1, citations: input.md_citations ?? prev.citations };
    this.items.set(a.id, a);
    return a;
  }

  rewrite(input: Json): Artifact {
    const prev = this.items.get(input.id)!;
    const a = {
      ...prev,
      title: input.title ?? prev.title,
      content: input.content ?? '',
      version: prev.version + 1,
      citations: input.md_citations ?? prev.citations,
    };
    this.items.set(a.id, a);
    return a;
  }
}

export function isArtifactCall(input: Json | null | undefined): boolean {
  if (!input) return false;
  return !!(
    (input.title && input.command === 'create' && input.content) ||
    (input.command === 'update' && input.old_str) ||
    (input.command === 'rewrite' && input.content)
  );
}

const TYPE_LANG: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.react': 'jsx',
  'application/vnd.ant.mermaid': 'mermaid',
  'text/css': 'css',
  'application/json': 'json',
};

export function artifactLanguage(type?: string, language?: string): string {
  if (language) return language;
  return (type && TYPE_LANG[type]) || '';
}

function isDeepResearch(a: Artifact): boolean {
  return a.type === 'text/markdown' && Array.isArray(a.citations) && a.citations.length > 0;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** `**Title** ∙ Version N` followed by the artifact in a fence. */
export function renderArtifact(a: Artifact): string {
  const version = a.version > 1 ? ` ∙ Version ${a.version}` : '';
  const head = `**${a.title}**${version}\n\n`;
  if (isDeepResearch(a)) {
    let out = `${head}${a.content.trim()}\n\n`;
    const seen = new Set<string>();
    const refs = (a.citations ?? []).filter((c) => c?.url && !seen.has(c.url) && seen.add(c.url));
    if (refs.length) {
      out += '\n---\n\n**References:**\n\n';
      refs.forEach((c, i) => {
        const title = String(c.metadata?.preview_title || c.title || c.url).replace(/[\r\n]+/g, ' ').trim();
        const host = hostname(c.url);
        out += `${i + 1}. [${title}${host ? ` (${host})` : ''}](${c.url})\n`;
      });
      out += '\n';
    }
    return out;
  }
  const body = a.content.trim();
  const fence = fenceFor(body, 4);
  return `${head}${fence}${artifactLanguage(a.type, a.language)}\n${body}\n${fence}\n\n`;
}
