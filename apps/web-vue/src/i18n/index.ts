import { createI18n } from "vue-i18n";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

/**
 * Console i18n. zh-CN is the source locale: every English namespace file is
 * typed against its zh-CN twin, so a missing or extra key fails `vue-tsc`.
 *
 * Message syntax reminder: `{` `}` `@` `$` `|` are special in vue-i18n
 * messages — write them as `{'@'}` etc. when they must appear literally.
 */
export type LocaleCode = "zh-CN" | "en";
export type MessageSchema = typeof zhCN;

export const availableLocales: { code: LocaleCode; name: string; short: string }[] = [
  { code: "zh-CN", name: "简体中文", short: "中" },
  { code: "en", name: "English", short: "EN" },
];

const STORAGE_KEY = "slipgate_locale";

function isLocaleCode(value: unknown): value is LocaleCode {
  return value === "zh-CN" || value === "en";
}

function detectLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocaleCode(saved)) return saved;
  } catch {
    // Storage may be unavailable (private mode); fall through to the browser language.
  }
  const lang = (navigator.language || "").toLowerCase();
  return lang.startsWith("zh") || !lang ? "zh-CN" : "en";
}

export const i18n = createI18n<[MessageSchema], LocaleCode, false>({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "zh-CN",
  messages: { "zh-CN": zhCN, en },
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
});

document.documentElement.setAttribute("lang", i18n.global.locale.value);

export function getLocale(): LocaleCode {
  return i18n.global.locale.value;
}

export function setLocale(code: LocaleCode) {
  i18n.global.locale.value = code;
  document.documentElement.setAttribute("lang", code);
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // ignore
  }
}

/** Translate an enum-ish backend value (`group.value`), falling back to the raw value. */
export function enumLabel(group: string, value: string | null | undefined): string {
  if (!value) return "-";
  const key = `enums.${group}.${value}`;
  return i18n.global.te(key) || i18n.global.te(key, "zh-CN") ? i18n.global.t(key) : value;
}

export default i18n;
