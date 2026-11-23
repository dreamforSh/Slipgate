import { computed, ref } from "vue";
import type { CaptchaProof, CaptchaScope } from "@slipgate/contracts";
import type CaptchaWidget from "../components/captcha/CaptchaWidget.vue";
import { captchaRenderable, captchaRequired } from "../lib/captcha";
import { usePortalStore } from "../stores/portal";

/**
 * Human verification on a public form, driven by the public settings: which flows need a
 * challenge, the widget to render (only then is any provider script loaded) and the proof to send.
 */
export function useCaptcha() {
  const portal = usePortalStore();
  const widget = ref<InstanceType<typeof CaptchaWidget> | null>(null);

  const config = computed(() => portal.settings?.captcha ?? null);
  /** A provider is on and its widget can render. */
  const available = computed(() => captchaRenderable(config.value));

  function required(scope: CaptchaScope): boolean {
    return captchaRequired(config.value, scope);
  }

  /**
   * The proof for a request: undefined when the flow needs none, null when it needs one and the
   * visitor hasn't produced it (the widget says why; don't send the request).
   */
  async function proof(needed: boolean): Promise<CaptchaProof | undefined | null> {
    if (!needed) return undefined;
    // Switched on but nothing rendered (settings changing under us): let the server decide.
    if (!available.value || !widget.value) return undefined;
    return widget.value.getProof();
  }

  function reset() {
    widget.value?.reset();
  }

  return { config, available, widget, required, proof, reset };
}
