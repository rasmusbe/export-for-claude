// Print page: fetches the Markdown export from the claude.ai tab, renders it
// to HTML and opens the print dialog (the user picks "Save as PDF").

import { Marked, type Tokens } from 'marked';
import { t, localisePage } from './i18n';
import { requestExport } from './messages';

const statusEl = document.getElementById('status')!;
const docEl = document.getElementById('doc')!;

function fail(message: string) {
  statusEl.textContent = message;
  statusEl.classList.add('error');
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SAFE_LINK = /^(https?:|mailto:|#)/i;
const SAFE_IMAGE = /^(https:|data:image\/(png|jpe?g|gif|webp);)/i;

/**
 * Chat content is untrusted: raw HTML is shown as text and only http(s),
 * mailto and in-page links are kept. Extension CSP blocks scripts as well.
 */
export const marked = new Marked({
  gfm: true,
  breaks: false,
  walkTokens(token) {
    if (token.type === 'link' && !SAFE_LINK.test((token as Tokens.Link).href)) (token as Tokens.Link).href = '#';
    if (token.type === 'image' && !SAFE_IMAGE.test((token as Tokens.Image).href)) (token as Tokens.Image).href = '';
  },
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

/** Wait for images before printing. Chat images are embedded as data: URLs. */
function imagesLoaded(root: HTMLElement, timeoutMs = 8000): Promise<void> {
  const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete);
  const all = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  );
  return Promise.race([all.then(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

async function main() {
  localisePage();
  document.title = t('extName');
  const tabId = Number(new URLSearchParams(location.search).get('tab'));
  if (!Number.isInteger(tabId) || tabId <= 0) {
    fail(t('printNoTab'));
    return;
  }
  const res = await requestExport(tabId, 'md', true);
  if (!res.ok) {
    fail(res.message);
    return;
  }
  document.title = res.filename.replace(/\.md$/, '');
  docEl.innerHTML = await marked.parse(res.content);
  for (const a of docEl.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  statusEl.textContent = '';
  await imagesLoaded(docEl);
  window.print();
}

main().catch((e) => fail(t('printFailed', (e as Error).message)));
