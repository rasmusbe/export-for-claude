import { parsePage } from '../core/page';
import {
  errorText,
  requestExport,
  requestFiles,
  type DownloadRequest,
  type DownloadResponse,
  type FilesProgress,
} from './messages';
import { localisePage, t, zipTexts } from './i18n';
import { uploadBytes, type Upload } from './upload';

localisePage();
document.title = t('extName');

const statusEl = document.getElementById('status')!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-format]')];
const zipButton = buttons.find((b) => b.dataset.format === 'zip')!;

/** Number of downloadable files, once counted. The zip button needs at least one. */
let fileCount = 0;
let busy = false;

function setFileCount(n: number) {
  fileCount = n;
  zipButton.textContent = t('popupZipCount', n);
  zipButton.disabled = n === 0 || busy;
}

function enableButtons() {
  busy = false;
  for (const b of buttons) b.disabled = b === zipButton && fileCount === 0;
}

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

/** The active tab, if it shows a claude.ai conversation. */
async function chatTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only visible for hosts we have permission for (claude.ai).
  if (!tab?.id || !tab.url || parsePage(tab.url).kind === 'other') return null;
  return tab;
}

/** Ask the background worker to save an upload. It owns the download from here, so the popup may close. */
async function requestDownload(filename: string, upload: Upload): Promise<DownloadResponse> {
  const req: DownloadRequest = { type: 'export-for-claude:download', filename, uploadId: upload.uploadId, count: upload.count, mime: upload.mime };
  const res = (await chrome.runtime.sendMessage(req)) as DownloadResponse | undefined;
  return res ?? { ok: false, message: t('errorNoBackground') };
}

async function saveFiles(tabId: number) {
  setStatus(t('statusFetching'));
  const res = await requestFiles(tabId, { action: 'zip' });
  if (!res.ok) {
    setStatus(res.message, true);
    return;
  }
  if (res.action !== 'zip') return;
  setStatus(t('statusSaving'));
  const saved = await requestDownload(res.filename, res.upload);
  if (!saved.ok) {
    setStatus(t('statusSaveFailed', saved.message), true);
    return;
  }
  const failed = res.missing.length;
  if (failed) setStatus(t('statusDonePartial', res.filename, failed, res.total, zipTexts().missingFileName), true);
  else setStatus(t('statusDone', res.filename));
}

async function run(format: string) {
  const tab = await chatTab();
  if (!tab) {
    setStatus(errorText('not_a_chat'), true);
    return;
  }
  if (format === 'pdf') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?tab=${tab.id}`) });
    window.close();
    return;
  }

  if (format === 'zip') {
    await saveFiles(tab.id!);
    return;
  }

  setStatus(t('statusFetching'));
  const res = await requestExport(tab.id!, format === 'json' ? 'json' : 'md');
  if (!res.ok) {
    setStatus(res.message, true);
    return;
  }
  setStatus(t('statusSaving'));
  let saved: DownloadResponse;
  try {
    const upload = await uploadBytes(new TextEncoder().encode(res.content), `${res.mime};charset=utf-8`);
    saved = await requestDownload(res.filename, upload);
  } catch (e) {
    saved = { ok: false, message: (e as Error).message };
  }
  if (saved.ok) setStatus(t('statusDone', res.filename));
  else setStatus(t('statusSaveFailed', saved.message), true);
}

for (const btn of buttons) {
  btn.addEventListener('click', async () => {
    busy = true;
    buttons.forEach((b) => (b.disabled = true));
    try {
      await run(btn.dataset.format ?? 'md');
    } catch (e) {
      setStatus(t('errorUnknownDetail', (e as Error).message), true);
    } finally {
      enableButtons();
    }
  });
}

chrome.runtime.onMessage.addListener((msg: FilesProgress) => {
  if (msg?.type === 'export-for-claude:files-progress') setStatus(t('statusFetchingFiles', msg.done, msg.total));
  return false;
});

chatTab().then(async (tab) => {
  if (!tab) {
    setStatus(errorText('not_a_chat'), true);
    return;
  }
  const res = await requestFiles(tab.id!, { action: 'count' });
  if (res.ok && res.action === 'count') setFileCount(res.count);
  else if (!res.ok) setStatus(res.message, true);
});
