import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { PublicSettings } from "@slipgate/contracts";

/**
 * Public portal settings (branding, registration switches, public pages). Loaded once per
 * session without auth; admins call `refresh()` after saving settings.
 */
export const usePortalStore = defineStore("portal", () => {
  const settings = ref<PublicSettings | null>(null);
  let inflight: Promise<PublicSettings | null> | null = null;

  async function load(force = false): Promise<PublicSettings | null> {
    if (settings.value && !force) return settings.value;
    inflight ??= (async () => {
      try {
        const res = await fetch("/api/v1/public/settings");
        if (res.ok) settings.value = (await res.json()) as PublicSettings;
      } catch {
        // Offline/dev without BFF: callers fall back to defaults.
      } finally {
        inflight = null;
      }
      return settings.value;
    })();
    return inflight;
  }

  const siteName = computed(() => settings.value?.siteName || "Slipgate");
  const logoUrl = computed(() => settings.value?.logoUrl || "");
  const subtitle = computed(() => settings.value?.siteSubtitle || "");

  return { settings, siteName, logoUrl, subtitle, load, refresh: () => load(true) };
});
