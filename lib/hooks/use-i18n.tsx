'use client';

import { createContext, useContext, useEffect, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Locale, defaultLocale, supportedLocales } from '@/lib/i18n';
import '@/lib/i18n/config';

const LOCALE_STORAGE_KEY = 'locale';

/**
 * Query parameter a host can use to choose the language, e.g. `?lang=th`.
 *
 * Exists for embedded deployments: an app framing this one in an iframe has no
 * other way to hand it a language. A same-origin host could write the storage
 * key directly, but that only works when both sides share an origin — which is
 * precisely the arrangement an embedder should not be forced into.
 *
 * The value goes through `resolveLocale`, so a host may pass a loose code
 * (`th`, `pt`) without knowing the exact locale identifier, and anything
 * unrecognised falls back rather than erroring.
 */
const LOCALE_QUERY_PARAM = 'lang';

/** Match a browser language code (e.g. 'en', 'zh-TW') to a supported locale */
function resolveLocale(lang: string): Locale {
  // Exact match
  const exact = supportedLocales.find((l) => l.code === lang);
  if (exact) return exact.code;
  // Prefix match: 'en' → 'en-US', 'zh' → 'zh-CN'
  const prefix = lang.split('-')[0].toLowerCase();
  const match = supportedLocales.find((l) => l.code.toLowerCase().startsWith(prefix));
  return match?.code ?? defaultLocale;
}

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();

  const locale = (i18n.language || defaultLocale) as Locale;

  // Detect language after hydration to avoid SSR mismatch.
  // i18next handles fallback automatically: if the detected language
  // has no matching JSON file, it falls back to fallbackLng.
  useEffect(() => {
    // Read the query first and outside the try: `location.search` cannot throw,
    // and a blocked localStorage must not cost the host its choice of language.
    const fromQuery = new URLSearchParams(window.location.search).get(LOCALE_QUERY_PARAM);
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      // localStorage unavailable; the query and the browser language still apply.
    }

    const target = resolveLocale(fromQuery || stored || navigator.language || defaultLocale);
    if (target !== i18n.language) i18n.changeLanguage(target);

    // Persist a host-supplied language so it survives in-app navigation, which
    // does not carry the query along.
    if (fromQuery) {
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, target);
      } catch {
        // Storage is optional here — the language is already applied.
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocale = (newLocale: Locale) => {
    i18n.changeLanguage(newLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable
    }
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
