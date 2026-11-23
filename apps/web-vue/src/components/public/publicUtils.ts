import { onBeforeUnmount, ref } from "vue";
import { platformShortLabel } from "../../lib/platformStyle";
import { PROVIDER_OPTIONS } from "../../lib/format";

/** Nano-USD per token → USD per 1M tokens (× multiplier). nano × 1e6 / 1e9 = nano / 1000. */
export function usdPerMillion(nanoPerToken: number, multiplier = 1): number {
  return (nanoPerToken * multiplier) / 1000;
}

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** $3.00 / $0.30 / $0.075 */
export function formatPerMillion(usd: number): string {
  return usd2.format(usd);
}

/** Provider sort rank: PROVIDER_OPTIONS order, unknown providers last. */
const PROVIDER_ORDER = new Map<string, number>(PROVIDER_OPTIONS.map((p, i) => [p.value, i]));
export function providerRank(provider: string): number {
  return PROVIDER_ORDER.get(provider) ?? 999;
}

export function providerLabel(provider: string): string {
  return platformShortLabel(provider);
}

/** Copy-to-clipboard with a short-lived "copied" marker keyed by the copied text. */
export function useCopyText(resetMs = 1500) {
  const copied = ref<string | null>(null);
  let timer: number | undefined;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = text;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (copied.value = null), resetMs);
    } catch {
      copied.value = null;
    }
  }
  onBeforeUnmount(() => window.clearTimeout(timer));
  return { copied, copy };
}

/** True when the user asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
