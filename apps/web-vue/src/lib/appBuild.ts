/**
 * Detects whether the web console being served now differs from the one this tab runs, by
 * comparing the hashed entry script of the live index.html with the one this document loaded.
 * After a restart that only reloaded processes the build is unchanged and no reload is needed.
 */

const ENTRY_RE = /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/i;

function loadedEntryPath(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!el?.src) return null;
  try {
    return new URL(el.src, window.location.href).pathname;
  } catch {
    return null;
  }
}

/** true / false when it could tell, null when it could not (no hashed entry, fetch failed). */
export async function frontendBuildChanged(): Promise<boolean | null> {
  const current = loadedEntryPath();
  if (!current) return null;
  try {
    const res = await fetch("/", { cache: "no-store", headers: { Accept: "text/html" } });
    if (!res.ok) return null;
    const match = ENTRY_RE.exec(await res.text());
    if (!match?.[1]) return null;
    return new URL(match[1], window.location.href).pathname !== current;
  } catch {
    return null;
  }
}

const FLASH_KEY = "slipgate.updates.flash";

export interface FlashMessage {
  tone: "success" | "warning" | "info";
  message: string;
}

/** Keeps a toast across the reload that loads a new console build. */
export function stashFlash(flash: FlashMessage): void {
  try {
    window.sessionStorage.setItem(FLASH_KEY, JSON.stringify(flash));
  } catch {
    // Storage unavailable: the toast is simply lost with the reload.
  }
}

export function takeFlash(): FlashMessage | null {
  try {
    const raw = window.sessionStorage.getItem(FLASH_KEY);
    window.sessionStorage.removeItem(FLASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FlashMessage>;
    if (typeof parsed.message !== "string") return null;
    const tone = parsed.tone === "warning" || parsed.tone === "info" ? parsed.tone : "success";
    return { tone, message: parsed.message };
  } catch {
    return null;
  }
}
