<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CaptchaProof } from "@slipgate/contracts";
import {
  loadAliyun,
  loadTencent,
  loadTurnstile,
  type CaptchaWidgetConfig,
  type TencentCaptchaInstance,
  type TencentCaptchaResult,
} from "../../lib/captcha";
import { useThemeStore } from "../../stores/theme";
import UiIcon from "../ui/UiIcon.vue";

/**
 * The active provider's human-verification widget, loaded on demand:
 * - Turnstile and Tencent (international) render inline and must be solved before submitting;
 * - Tencent (China) pops its challenge up when the form asks for a proof;
 * - Aliyun shows a "click to verify" button that opens its popup (also opened on submit).
 *
 * The parent calls `getProof()` right before a guarded request (null: not solved, the widget says
 * why) and `reset()` after any request that used the answer: answers are one-time.
 */
export type CaptchaWidgetState = "loading" | "ready" | "verifying" | "solved" | "error";

const props = defineProps<{ config: CaptchaWidgetConfig }>();
const emit = defineEmits<{ (e: "state", state: CaptchaWidgetState): void }>();

const { t, locale } = useI18n();
const theme = useThemeStore();

/** How long a submit waits for Turnstile's automatic (non-interactive) pass. */
const TURNSTILE_GRACE_MS = 4_000;
/** Tencent international tickets live 5 minutes; give up on a cached one a minute early. */
const TENCENT_TICKET_MAX_AGE_MS = 4 * 60_000;
const ALIYUN_POPUP_ID = "aliyunCaptcha-window-popup";
const ALIYUN_MASK_ID = "aliyunCaptcha-mask";
const ALIYUN_OPEN_TIMEOUT_MS = 8_000;

const state = ref<CaptchaWidgetState>("loading");
/** i18n key of the inline line under the widget (an error, or "solve it first"). */
const notice = ref<string | null>(null);
const root = ref<HTMLElement | null>(null);
const mountEl = ref<HTMLElement | null>(null);

watch(state, (s) => emit("state", s), { immediate: true });

const provider = computed(() => props.config.provider);
const tencentIntl = computed(() => provider.value === "tencent" && props.config.tencentRegion === "intl");
const isZh = computed(() => locale.value.toLowerCase().startsWith("zh"));
/** Identity of the configuration: any change re-creates the widget. */
const configKey = computed(() =>
  [
    props.config.provider,
    props.config.turnstileSiteKey,
    props.config.tencentAppId,
    props.config.tencentRegion,
    props.config.aliyunSceneId,
    props.config.aliyunPrefix,
    props.config.aliyunRegion,
  ].join("|"),
);

const uid = Math.random().toString(36).slice(2, 10);
const aliyunButtonId = `sg-aliyun-btn-${uid}`;
const aliyunElementId = `sg-aliyun-el-${uid}`;

/** Bumped on every (re)initialisation: late callbacks of a torn-down widget are ignored. */
let generation = 0;
let disposed = false;

/* ---------------- Turnstile ---------------- */

let turnstileId: string | null = null;
let turnstileToken = "";
let turnstileWaiters: ((token: string | null) => void)[] = [];

function settleTurnstile(token: string | null) {
  const waiters = turnstileWaiters;
  turnstileWaiters = [];
  for (const w of waiters) w(token);
}

async function initTurnstile(gen: number) {
  const api = await loadTurnstile();
  if (gen !== generation || !mountEl.value) return;
  mountEl.value.innerHTML = "";
  turnstileToken = "";
  turnstileId = api.render(mountEl.value, {
    sitekey: props.config.turnstileSiteKey,
    theme: theme.isDark ? "dark" : "light",
    size: "flexible",
    language: isZh.value ? "zh-CN" : "en",
    callback: (token) => {
      if (gen !== generation) return;
      turnstileToken = token;
      notice.value = null;
      state.value = "solved";
      settleTurnstile(token);
    },
    "expired-callback": () => {
      if (gen !== generation) return;
      turnstileToken = "";
      state.value = "ready";
    },
    "timeout-callback": () => {
      if (gen !== generation) return;
      turnstileToken = "";
      state.value = "ready";
    },
    "error-callback": () => {
      if (gen !== generation) return;
      // Turnstile shows (and retries) its own error inside the frame.
      turnstileToken = "";
      state.value = "ready";
      settleTurnstile(null);
    },
  });
  state.value = "ready";
}

function removeTurnstile() {
  if (turnstileId && window.turnstile) {
    try {
      window.turnstile.remove(turnstileId);
    } catch {
      // Already gone.
    }
  }
  turnstileId = null;
  turnstileToken = "";
  settleTurnstile(null);
}

async function turnstileProof(): Promise<CaptchaProof | null> {
  if (!turnstileToken && state.value !== "error") {
    // A submit right after the page opened: give the automatic pass a moment to arrive.
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        turnstileWaiters = turnstileWaiters.filter((w) => w !== done);
        resolve();
      }, TURNSTILE_GRACE_MS);
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      turnstileWaiters.push(done);
    });
  }
  return turnstileToken ? { turnstileToken } : null;
}

/* ---------------- Tencent ---------------- */

let tencentInstance: TencentCaptchaInstance | null = null;
/** International: the ticket the inline checkbox produced, until used. */
let tencentCached: { proof: CaptchaProof; at: number } | null = null;

function tencentResultProof(res: TencentCaptchaResult): CaptchaProof | "closed" | "failed" {
  if (res.ret === 2) return "closed";
  const ticket = res.ticket?.trim() ?? "";
  const randstr = res.randstr?.trim() ?? "";
  // "trerror_" tickets are the SDK's own failure placeholders: the server refuses them anyway.
  if (!ticket || !randstr || ticket.startsWith("trerror_") || res.errorCode !== undefined) return "failed";
  return { tencentTicket: ticket, tencentRandstr: randstr };
}

function destroyTencent() {
  try {
    tencentInstance?.destroy();
  } catch {
    // Already gone.
  }
  tencentInstance = null;
}

async function initTencent(gen: number) {
  const Ctor = await loadTencent(props.config.tencentRegion);
  if (gen !== generation) return;
  if (!tencentIntl.value) {
    // China site: the challenge pops up on submit; the script is preloaded so it opens at once.
    state.value = "ready";
    return;
  }
  // International site: a Robot checkbox inside our container, ticked before submitting.
  await nextTick();
  if (gen !== generation || !mountEl.value) return;
  destroyTencent();
  tencentCached = null;
  mountEl.value.innerHTML = "";
  tencentInstance = new Ctor(
    mountEl.value,
    props.config.tencentAppId,
    (res) => {
      if (gen !== generation) return;
      const out = tencentResultProof(res);
      if (out === "closed") return;
      if (out === "failed") {
        state.value = "error";
        notice.value = "authGuards.captcha.widgetError";
        return;
      }
      tencentCached = { proof: out, at: Date.now() };
      notice.value = null;
      state.value = "solved";
    },
    { enableAutoCheck: false, userLanguage: isZh.value ? "zh-cn" : "en", type: "popup" },
  );
  tencentInstance.show();
  state.value = "ready";
}

async function tencentProof(): Promise<CaptchaProof | null> {
  if (tencentIntl.value) {
    if (tencentCached && Date.now() - tencentCached.at < TENCENT_TICKET_MAX_AGE_MS) return tencentCached.proof;
    if (tencentCached) void reinit();
    return null;
  }
  const gen = generation;
  const Ctor = await loadTencent("cn");
  if (gen !== generation) return null;
  state.value = "verifying";
  return new Promise<CaptchaProof | null>((resolve) => {
    destroyTencent();
    tencentInstance = new Ctor(
      props.config.tencentAppId,
      (res) => {
        const out = tencentResultProof(res);
        destroyTencent();
        if (gen !== generation) return resolve(null);
        if (out === "closed") {
          state.value = "ready";
          return resolve(null);
        }
        if (out === "failed") {
          state.value = "error";
          notice.value = "authGuards.captcha.widgetError";
          return resolve(null);
        }
        state.value = "ready";
        resolve(out);
      },
      { userLanguage: isZh.value ? "zh-cn" : "en" },
    );
    tencentInstance.show();
  });
}

/* ---------------- Aliyun ---------------- */

let aliyunParam: string | null = null;
let aliyunWaiter: ((param: string | null) => void) | null = null;
let aliyunWatch: number | null = null;

function settleAliyun(param: string | null) {
  const w = aliyunWaiter;
  aliyunWaiter = null;
  w?.(param);
}

function stopAliyunWatch() {
  if (aliyunWatch !== null) window.clearInterval(aliyunWatch);
  aliyunWatch = null;
}

function aliyunPopupVisible(): boolean {
  const popup = document.getElementById(ALIYUN_POPUP_ID);
  return Boolean(popup && window.getComputedStyle(popup).display !== "none");
}

/**
 * The SDK has no "closed" callback: watch the popup. Seen and then gone without an answer means
 * the visitor closed it; never seen means it failed to open (the SDK binds the button
 * asynchronously, so the click is repeated until the popup shows).
 */
function startAliyunWatch() {
  stopAliyunWatch();
  const startedAt = Date.now();
  let seen = false;
  aliyunWatch = window.setInterval(() => {
    if (state.value === "solved") return stopAliyunWatch();
    if (aliyunPopupVisible()) {
      seen = true;
      return;
    }
    if (seen || Date.now() - startedAt > ALIYUN_OPEN_TIMEOUT_MS) {
      stopAliyunWatch();
      state.value = "ready";
      settleAliyun(null);
      return;
    }
    document.getElementById(aliyunButtonId)?.click();
  }, 300);
}

function onAliyunClick() {
  if (state.value === "solved" || state.value === "loading" || state.value === "error") return;
  state.value = "verifying";
  if (aliyunWatch === null) startAliyunWatch();
}

async function initAliyun(gen: number) {
  await loadAliyun(props.config.aliyunRegion, props.config.aliyunPrefix);
  if (gen !== generation) return;
  await nextTick();
  if (gen !== generation || !window.initAliyunCaptcha) return;
  aliyunParam = null;
  window.initAliyunCaptcha({
    SceneId: props.config.aliyunSceneId,
    prefix: props.config.aliyunPrefix,
    mode: "popup",
    element: `#${aliyunElementId}`,
    button: `#${aliyunButtonId}`,
    // No business call here: the parameter travels with the guarded request and the server verifies it.
    captchaVerifyCallback: (param) => {
      if (gen === generation) {
        stopAliyunWatch();
        aliyunParam = param;
        notice.value = null;
        state.value = "solved";
        settleAliyun(param);
      }
      return { captchaResult: true, bizResult: true };
    },
    onBizResultCallback: () => {},
    getInstance: () => {},
    slideStyle: { width: 360, height: 40 },
    language: isZh.value ? "cn" : "en",
  });
  state.value = "ready";
}

async function aliyunProof(): Promise<CaptchaProof | null> {
  if (aliyunParam) return { aliyunVerifyParam: aliyunParam };
  settleAliyun(null);
  const param = await new Promise<string | null>((resolve) => {
    aliyunWaiter = resolve;
    onAliyunClick();
    document.getElementById(aliyunButtonId)?.click();
  });
  return param ? { aliyunVerifyParam: param } : null;
}

function removeAliyun() {
  stopAliyunWatch();
  settleAliyun(null);
  aliyunParam = null;
  // The SDK never removes its popup; a leftover one would answer for the next widget.
  document.getElementById(ALIYUN_MASK_ID)?.remove();
  document.getElementById(ALIYUN_POPUP_ID)?.remove();
}

/* ---------------- Lifecycle ---------------- */

function teardown() {
  generation += 1;
  removeTurnstile();
  destroyTencent();
  tencentCached = null;
  removeAliyun();
}

async function init() {
  teardown();
  const gen = generation;
  state.value = "loading";
  notice.value = null;
  try {
    if (provider.value === "turnstile") await initTurnstile(gen);
    else if (provider.value === "tencent") await initTencent(gen);
    else if (provider.value === "aliyun") await initAliyun(gen);
  } catch (err) {
    if (gen !== generation) return;
    state.value = "error";
    notice.value =
      err instanceof Error && err.message === "captcha_region_changed" ? "authGuards.captcha.reloadNeeded" : "authGuards.captcha.loadFailed";
  }
}

function reinit() {
  if (!disposed) void init();
}

onMounted(() => void init());
onBeforeUnmount(() => {
  disposed = true;
  teardown();
});
watch(configKey, reinit);
// Turnstile can't change theme or language after rendering: re-render while nothing is solved yet.
watch([() => theme.isDark, isZh], () => {
  if (provider.value === "turnstile" && state.value !== "solved" && state.value !== "loading") reinit();
});

/* ---------------- API for the parent form ---------------- */

/**
 * The answer to send with the guarded request, or null when there is none yet (the widget then
 * shows why: solve it first, closed popup, failed to load). Popups open here.
 */
async function getProof(): Promise<CaptchaProof | null> {
  if (state.value === "loading") {
    notice.value = "authGuards.captcha.stillLoading";
    return null;
  }
  if (state.value === "error") {
    reinit();
    return null;
  }
  let proof: CaptchaProof | null = null;
  try {
    if (provider.value === "turnstile") proof = await turnstileProof();
    else if (provider.value === "tencent") proof = await tencentProof();
    else if (provider.value === "aliyun") proof = await aliyunProof();
  } catch {
    state.value = "error";
    notice.value = "authGuards.captcha.loadFailed";
    return null;
  }
  // The provider calls above may have changed the state meanwhile (TS can't see that).
  const now = state.value as CaptchaWidgetState;
  if (!proof && now !== "error" && now !== "loading") notice.value = "authGuards.captcha.completeFirst";
  if (!proof) focus();
  return proof;
}

/** Answers are one-time: start over after any request that carried one. */
function reset() {
  notice.value = null;
  if (provider.value === "turnstile") {
    turnstileToken = "";
    if (turnstileId && window.turnstile) {
      try {
        window.turnstile.reset(turnstileId);
        state.value = "ready";
        return;
      } catch {
        // Fall through to a full re-render.
      }
    }
    reinit();
  } else if (tencentIntl.value) {
    reinit();
  } else if (provider.value === "aliyun") {
    stopAliyunWatch();
    settleAliyun(null);
    aliyunParam = null;
    if (state.value !== "loading" && state.value !== "error") state.value = "ready";
  } else if (state.value === "verifying") {
    state.value = "ready";
  }
}

/** Shows the widget the visitor needs to deal with. */
function focus() {
  root.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  root.value?.focus({ preventScroll: true });
}

defineExpose({ getProof, reset, focus });

const aliyunLabel = computed(() => {
  if (state.value === "solved") return t("authGuards.captcha.verified");
  if (state.value === "verifying") return t("authGuards.captcha.verifying");
  if (state.value === "loading") return t("authGuards.captcha.loading");
  return t("authGuards.captcha.clickToVerify");
});
</script>

<template>
  <div
    ref="root"
    tabindex="-1"
    class="min-w-0 rounded-lg outline-none"
    role="group"
    :aria-label="t('authGuards.captcha.label')"
    :aria-busy="state === 'loading' || state === 'verifying'"
  >
    <!-- Turnstile: inline frame (flexible width) -->
    <div v-if="provider === 'turnstile'" class="relative min-h-[65px]">
      <Transition
        leave-active-class="transition-opacity duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <div
          v-if="state === 'loading'"
          class="absolute inset-0 flex items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3.5 text-xs text-fg-subtle"
        >
          <span class="h-5 w-5 shrink-0 animate-pulse rounded bg-surface-3 motion-reduce:animate-none" />
          {{ t("authGuards.captcha.loading") }}
        </div>
      </Transition>
      <div ref="mountEl" class="turnstile-slot" />
    </div>

    <!-- Tencent (international): Robot checkbox -->
    <div v-else-if="tencentIntl" class="relative min-h-[60px]">
      <div
        v-if="state === 'loading'"
        class="absolute inset-0 flex items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3.5 text-xs text-fg-subtle"
      >
        <span class="h-5 w-5 shrink-0 animate-pulse rounded bg-surface-3 motion-reduce:animate-none" />
        {{ t("authGuards.captcha.loading") }}
      </div>
      <div ref="mountEl" class="flex min-h-[60px] w-full justify-center" />
    </div>

    <!-- Tencent (China): popup on submit -->
    <p
      v-else-if="provider === 'tencent'"
      class="flex items-center gap-1.5 rounded-lg bg-surface-2/60 px-3 py-2 text-2xs text-fg-subtle ring-1 ring-inset ring-line/70"
    >
      <UiIcon :name="state === 'verifying' ? 'loader' : 'shield'" :size="13" :spin="state === 'verifying'" class="shrink-0 text-accent" />
      <span class="min-w-0">{{ t("authGuards.captcha.popupNotice") }}</span>
    </p>

    <!-- Aliyun: trigger button bound by the SDK -->
    <div v-else-if="provider === 'aliyun'">
      <button
        :id="aliyunButtonId"
        type="button"
        class="btn h-10 w-full border transition-colors"
        :class="
          state === 'solved'
            ? 'border-success/40 bg-success/[0.07] text-success'
            : 'btn-secondary'
        "
        :disabled="state === 'solved' || state === 'loading' || state === 'error'"
        :aria-pressed="state === 'solved'"
        @click="onAliyunClick"
      >
        <UiIcon
          :name="state === 'solved' ? 'check-circle' : state === 'verifying' || state === 'loading' ? 'loader' : 'shield'"
          :size="15"
          :spin="state === 'verifying' || state === 'loading'"
        />
        {{ aliyunLabel }}
      </button>
      <div :id="aliyunElementId" />
    </div>

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      enter-from-class="-translate-y-0.5 opacity-0"
      leave-to-class="opacity-0"
    >
      <p
        v-if="notice"
        class="mt-1.5 flex items-start gap-1.5 text-xs"
        :class="state === 'error' ? 'text-danger' : 'text-warning'"
        role="alert"
      >
        <UiIcon :name="state === 'error' ? 'x-circle' : 'alert'" :size="13" class="mt-px shrink-0" />
        <span class="min-w-0 flex-1">{{ t(notice) }}</span>
        <button
          v-if="state === 'error'"
          type="button"
          class="shrink-0 cursor-pointer font-medium text-accent hover:underline"
          @click="reinit"
        >
          {{ t("authGuards.captcha.retry") }}
        </button>
      </p>
    </Transition>
  </div>
</template>

<style scoped>
.turnstile-slot {
  min-height: 65px;
  width: 100%;
}
/* The flexible Turnstile frame takes the full width of the form. */
.turnstile-slot :deep(iframe) {
  width: 100% !important;
}
</style>
