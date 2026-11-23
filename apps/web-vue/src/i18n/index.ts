import { createI18n } from "vue-i18n";
import zhCN from "./locales/zh-CN";

/**
 * Console i18n. zh-CN is the source locale: every English namespace file is
 * typed against its zh-CN twin, so a missing or extra key fails `vue-tsc`.
 *
 * Only zh-CN (source and fallback) ships in the entry chunk; other locales are
 * fetched on demand, and the app mounts after the detected locale is ready.
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
  locale: "zh-CN",
  fallbackLocale: "zh-CN",
  messages: { "zh-CN": zhCN } as Record<LocaleCode, MessageSchema>,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
});

const loaders: Record<Exclude<LocaleCode, "zh-CN">, () => Promise<{ default: MessageSchema }>> = {
  en: () => import("./locales/en"),
};
const loaded = new Set<LocaleCode>(["zh-CN"]);

async function ensureMessages(code: LocaleCode): Promise<void> {
  if (loaded.has(code) || code === "zh-CN") return;
  const mod = await loaders[code]();
  i18n.global.setLocaleMessage(code, mod.default);
  loaded.add(code);
}

function applyLocale(code: LocaleCode) {
  i18n.global.locale.value = code;
  document.documentElement.setAttribute("lang", code);
}

applyLocale("zh-CN");

/** Resolves once the detected locale's messages are in place (zh-CN if loading fails). */
export const i18nReady: Promise<void> = (async () => {
  const code = detectLocale();
  try {
    await ensureMessages(code);
    applyLocale(code);
  } catch {
    // Network hiccup: stay on the bundled source locale.
  }
})();

export function getLocale(): LocaleCode {
  return i18n.global.locale.value;
}

export async function setLocale(code: LocaleCode): Promise<void> {
  await ensureMessages(code);
  applyLocale(code);
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
