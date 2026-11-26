// Thin wrapper around chrome.i18n. Texts live in public/_locales/{en,sv}/messages.json;
// English is the default locale. The core stays free of chrome.*: it receives
// these strings as parameters (see zipTexts).

import type { ZipTexts } from '../core';

/** Localised message, with $1..$9 substitutions. */
export function t(key: string, ...subs: Array<string | number>): string {
  return chrome.i18n.getMessage(key, subs.map(String));
}

/** Texts the core puts inside the zip. */
export function zipTexts(): ZipTexts {
  return {
    zipSuffix: t('zipSuffix'),
    missingFileName: t('missingFileName'),
    missingHeading: t('missingHeading'),
    reasonNotFound: t('reasonNotFound'),
    reasonNoAccess: t('reasonNoAccess'),
    reasonRateLimited: t('reasonRateLimited'),
    reasonNetwork: t('reasonNetwork'),
    reasonUnknown: t('reasonUnknown'),
  };
}

/**
 * Fill an extension page: `<html lang>` from the UI language and the text of
 * every `data-i18n` attribute.
 */
export function localisePage(): void {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
}
