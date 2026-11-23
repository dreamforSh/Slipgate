<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CaptchaConfig, CaptchaProvider, CaptchaScope, CaptchaTestRequest, CaptchaTestResult } from "@slipgate/contracts";
import { apiJson, errorText } from "../../lib/api";
import { captchaRenderable } from "../../lib/captcha";
import SecretInput from "../payments/SecretInput.vue";
import CaptchaWidget from "../captcha/CaptchaWidget.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import SettingField from "./SettingField.vue";
import SettingSwitchRow from "./SettingSwitchRow.vue";
import {
  CAPTCHA_SCOPE_KEYS,
  PROVIDER_FIELDS,
  secretIsSet,
  widgetConfigOf,
  type CaptchaFieldKey,
  type CaptchaForm,
  type CaptchaSecretField,
} from "./captchaForm";
import type { CaptchaFailure } from "./useAuthGuardSettings";

/**
 * Settings → Sign-in security: the human-verification provider (Turnstile, Tencent, Aliyun), its
 * keys, where challenges are required, and tests against the saved configuration. Edits stay in
 * the parent's form so the page's sticky save bar saves them; the server checks changed keys with
 * the provider before saving, so a wrong key can't lock everyone out.
 */
const form = defineModel<CaptchaForm | null>({ required: true });
const props = defineProps<{
  saved: CaptchaConfig | null;
  loading: boolean;
  loadError: string | null;
  dirtyKeys: CaptchaFieldKey[];
  errors: Partial<Record<CaptchaFieldKey, string>>;
  failure: CaptchaFailure | null;
}>();
const emit = defineEmits<{ (e: "retry"): void }>();

const { t } = useI18n();

const errorClass = "!border-danger/60 focus:!ring-danger/20";
const isDirty = (k: CaptchaFieldKey) => props.dirtyKeys.includes(k);
const err = (k: CaptchaFieldKey) => props.errors[k] ?? null;

/* ---------------- Provider ---------------- */

const PROVIDER_ICON: Record<CaptchaProvider, IconName> = {
  none: "x-circle",
  turnstile: "globe",
  tencent: "fingerprint",
  aliyun: "shield",
};
const PROVIDER_DOCS: Record<Exclude<CaptchaProvider, "none">, string> = {
  turnstile: "https://dash.cloudflare.com/?to=/:account/turnstile",
  tencent: "https://console.cloud.tencent.com/captcha/graphical",
  aliyun: "https://yundun.console.aliyun.com/?p=captcha",
};
const providers = computed(() =>
  (["none", "turnstile", "tencent", "aliyun"] as CaptchaProvider[]).map((value) => ({
    value,
    icon: PROVIDER_ICON[value],
    name: t(`authGuards.settings.captcha.providers.${value}.name`),
    desc: t(`authGuards.settings.captcha.providers.${value}.desc`),
  })),
);

function pick(p: CaptchaProvider) {
  if (form.value) form.value.provider = p;
}

function onProviderKey(ev: KeyboardEvent, index: number) {
  const list = providers.value;
  let next = -1;
  if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (index + 1) % list.length;
  else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (index - 1 + list.length) % list.length;
  if (next < 0) return;
  ev.preventDefault();
  pick(list[next]!.value);
  ((ev.currentTarget as HTMLElement).parentElement?.children[next] as HTMLElement | undefined)?.focus();
}

const statusBadge = computed(() => {
  const s = props.saved;
  if (!s || s.provider === "none") return { tone: "neutral" as const, text: t("authGuards.settings.captcha.statusOff") };
  return { tone: "success" as const, text: t("authGuards.settings.captcha.statusOn", { name: t(`authGuards.settings.captcha.providers.${s.provider}.name`) }) };
});

const tencentRegions = computed(() => [
  { value: "cn" as const, label: t("authGuards.settings.captcha.tencent.regionCn") },
  { value: "intl" as const, label: t("authGuards.settings.captcha.tencent.regionIntl") },
]);
const aliyunRegions = computed(() => [
  { value: "cn" as const, label: t("authGuards.settings.captcha.aliyun.regionCn") },
  { value: "sgp" as const, label: t("authGuards.settings.captcha.aliyun.regionSgp") },
]);

function secretSet(field: CaptchaSecretField): boolean {
  return props.saved ? secretIsSet(props.saved, field) : false;
}

/** Which provider fields are still empty (for the "x of y filled" hint). */
const completeness = computed(() => {
  const f = form.value;
  if (!f || f.provider === "none") return null;
  const fields = PROVIDER_FIELDS[f.provider];
  const missing = fields.filter((k) => Boolean(props.errors[k])).length;
  return { done: fields.length - missing, total: fields.length };
});

/* ---------------- Scopes ---------------- */

const SCOPE_ICON: Record<CaptchaScope, IconName> = {
  login: "log-in",
  register: "user-plus",
  emailCode: "mail",
  forgotPassword: "rotate-ccw",
  oauth: "link",
};

const scopeDirty = (s: CaptchaScope) => isDirty(`scopes.${s}` as const);
const scopesOn = computed(() => (form.value ? CAPTCHA_SCOPE_KEYS.filter((s) => form.value!.scopes[s]).length : 0));

/* ---------------- Tests ---------------- */

const testing = ref<"credentials" | "token" | null>(null);
const testResult = ref<CaptchaTestResult | null>(null);
const testError = ref<string | null>(null);
const tryOpen = ref(false);
const tryWidget = ref<InstanceType<typeof CaptchaWidget> | null>(null);

/** Provider whose saved keys a test uses: the one being edited, else the active one. */
const testProvider = computed<Exclude<CaptchaProvider, "none"> | null>(() => {
  const p = form.value?.provider && form.value.provider !== "none" ? form.value.provider : props.saved?.provider;
  return p && p !== "none" ? p : null;
});
const credentialEdits = computed(() =>
  props.dirtyKeys.some((k) => k !== "provider" && !k.startsWith("scopes.")),
);
/** The challenge box renders the saved active provider (what visitors get). */
const tryConfig = computed(() => (props.saved && captchaRenderable(widgetConfigOf(props.saved)) ? widgetConfigOf(props.saved) : null));

watch(
  () => props.saved,
  () => {
    testResult.value = null;
    testError.value = null;
    if (!tryConfig.value) tryOpen.value = false;
  },
);

async function runTest(body: CaptchaTestRequest, mode: "credentials" | "token") {
  testing.value = mode;
  testResult.value = null;
  testError.value = null;
  try {
    testResult.value = await apiJson<CaptchaTestResult>("/api/v1/admin/captcha/test", { method: "POST", body });
  } catch (e) {
    testError.value = errorText(e, t("authGuards.settings.captcha.test.failed"));
  } finally {
    testing.value = null;
  }
}

function testCredentials() {
  if (!testProvider.value || testing.value) return;
  void runTest({ provider: testProvider.value }, "credentials");
}

async function testChallenge() {
  if (!tryConfig.value || testing.value || !tryWidget.value) return;
  const proof = await tryWidget.value.getProof();
  if (!proof) return;
  await runTest({ provider: tryConfig.value.provider as Exclude<CaptchaProvider, "none">, captcha: proof }, "token");
  tryWidget.value?.reset();
}

const resultView = computed(() => {
  const r = testResult.value;
  if (!r) return null;
  const name = t(`authGuards.settings.captcha.providers.${r.provider}.name`);
  if (r.ok) {
    return {
      tone: "success" as const,
      title: r.mode === "token" ? t("authGuards.settings.captcha.test.tokenOk") : t("authGuards.settings.captcha.test.credentialsOk", { name }),
      detail: r.detail,
    };
  }
  const code = r.error ?? "captcha_unavailable";
  return { tone: "danger" as const, title: t(`authGuards.errors.${code}`), detail: r.detail };
});

const failureTitle = computed(() => {
  const code = props.failure?.code;
  return code && ["captcha_invalid_credentials", "captcha_unavailable", "captcha_not_configured"].includes(code)
    ? t(`authGuards.errors.${code}`)
    : t("authGuards.settings.captcha.saveFailed");
});

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 5) * 60}ms`, animationFillMode: "both" });
</script>

<template>
  <!-- Load failed -->
  <UiAlert v-if="!form && loadError && !loading" tone="danger" :title="t('authGuards.settings.captcha.loadFailed')">
    {{ loadError }}
    <template #action>
      <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="emit('retry')">
        {{ t("settings.retry") }}
      </button>
    </template>
  </UiAlert>

  <!-- Loading -->
  <div v-else-if="!form || !saved" class="grid gap-6 xl:grid-cols-5" aria-busy="true">
    <div class="card space-y-4 p-5 xl:col-span-3">
      <div class="h-4 w-40 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
      <div class="grid gap-2 sm:grid-cols-4">
        <div v-for="i in 4" :key="i" class="h-20 animate-pulse rounded-xl bg-surface-2/70 motion-reduce:animate-none" />
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div v-for="j in 2" :key="j" class="space-y-2">
          <div class="h-3 w-24 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
          <div class="h-9 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
    <div class="card space-y-3 p-5 xl:col-span-2">
      <div class="h-4 w-32 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
      <div v-for="j in 4" :key="j" class="h-8 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
    </div>
  </div>

  <div v-else class="grid gap-6 xl:grid-cols-5">
    <!-- Provider & keys -->
    <UiCard
      class="animate-slide-up motion-reduce:animate-none xl:col-span-3"
      :style="stagger(0)"
      icon="shield"
      :title="t('authGuards.settings.captcha.title')"
    >
      <template #actions>
        <UiBadge :tone="statusBadge.tone" dot>{{ statusBadge.text }}</UiBadge>
      </template>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="failure" tone="danger" class="mb-4" :title="failureTitle">
          <span class="break-words">{{ failure.message }}</span>
        </UiAlert>
      </Transition>

      <p class="text-xs leading-relaxed text-fg-subtle">{{ t("authGuards.settings.captcha.help") }}</p>

      <!-- Provider picker -->
      <div
        class="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4"
        role="radiogroup"
        :aria-label="t('authGuards.settings.captcha.provider')"
      >
        <button
          v-for="(p, i) in providers"
          :key="p.value"
          type="button"
          role="radio"
          :aria-checked="form.provider === p.value"
          :tabindex="form.provider === p.value ? 0 : -1"
          class="group relative flex min-w-0 cursor-pointer flex-col items-start gap-2 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          :class="
            form.provider === p.value
              ? 'border-accent/50 bg-accent/[0.06] shadow-sm'
              : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/50 dark:bg-surface-2/30'
          "
          @click="pick(p.value)"
          @keydown="onProviderKey($event, i)"
        >
          <span class="flex w-full items-center justify-between gap-2">
            <span class="icon-chip h-8 w-8" :class="form.provider === p.value ? (p.value === 'none' ? '' : 'icon-chip-accent') : ''">
              <UiIcon :name="p.icon" :size="15" />
            </span>
            <Transition
              enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
              enter-from-class="scale-50 opacity-0"
            >
              <UiIcon v-if="form.provider === p.value" name="check-circle" :size="15" class="text-accent" />
            </Transition>
          </span>
          <span class="min-w-0">
            <span class="flex items-center gap-1.5 text-sm font-medium text-fg">
              <span class="truncate">{{ p.name }}</span>
              <span
                v-if="saved.provider === p.value && p.value !== 'none'"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                :title="t('authGuards.settings.captcha.active')"
              />
            </span>
            <span class="mt-0.5 line-clamp-2 block text-2xs leading-relaxed text-fg-subtle">{{ p.desc }}</span>
          </span>
        </button>
      </div>

      <!-- Provider fields -->
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="form.provider === 'none'" key="none" class="mt-5 flex items-start gap-2.5 rounded-lg border border-dashed border-line px-3.5 py-3 text-xs leading-relaxed text-fg-subtle">
          <UiIcon name="info" :size="14" class="mt-px shrink-0" />
          {{ t("authGuards.settings.captcha.offNote") }}
        </div>

        <div v-else :key="form.provider" class="mt-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="eyebrow">{{ t("authGuards.settings.captcha.keysTitle", { name: t(`authGuards.settings.captcha.providers.${form.provider}.name`) }) }}</p>
            <a
              :href="PROVIDER_DOCS[form.provider]"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              {{ t("authGuards.settings.captcha.console") }}
              <UiIcon name="external-link" :size="12" />
            </a>
          </div>

          <!-- Turnstile -->
          <div v-if="form.provider === 'turnstile'" class="grid gap-4 sm:grid-cols-2">
            <SettingField
              input-id="cap-turnstile-site"
              :label="t('authGuards.settings.captcha.turnstile.siteKey')"
              required
              :dirty="isDirty('turnstileSiteKey')"
              :error="err('turnstileSiteKey')"
            >
              <input
                id="cap-turnstile-site"
                v-model="form.turnstileSiteKey"
                type="text"
                spellcheck="false"
                autocomplete="off"
                maxlength="256"
                class="input font-mono"
                :class="err('turnstileSiteKey') ? errorClass : ''"
                placeholder="0x4AAAAAAA…"
              />
            </SettingField>
            <div>
              <SecretInput
                v-model="form.turnstileSecretKey"
                :is-set="secretSet('turnstileSecretKey')"
                :label="t('authGuards.settings.captcha.turnstile.secretKey')"
              />
              <p v-if="err('turnstileSecretKey')" class="mt-1 text-xs text-danger" role="alert">{{ err("turnstileSecretKey") }}</p>
            </div>
            <p class="hint sm:col-span-2">{{ t("authGuards.settings.captcha.turnstile.help") }}</p>
          </div>

          <!-- Tencent -->
          <div v-else-if="form.provider === 'tencent'" class="grid gap-4 sm:grid-cols-2">
            <SettingField
              class="sm:col-span-2"
              :label="t('authGuards.settings.captcha.tencent.region')"
              :dirty="isDirty('tencentRegion')"
              :hint="t('authGuards.settings.captcha.tencent.regionHelp')"
            >
              <SegmentedControl v-model="form.tencentRegion" :options="tencentRegions" size="md" />
            </SettingField>
            <SettingField
              input-id="cap-tencent-app"
              :label="t('authGuards.settings.captcha.tencent.appId')"
              required
              :dirty="isDirty('tencentAppId')"
              :error="err('tencentAppId')"
            >
              <input
                id="cap-tencent-app"
                v-model="form.tencentAppId"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                autocomplete="off"
                maxlength="20"
                class="input font-mono"
                :class="err('tencentAppId') ? errorClass : ''"
                placeholder="190000000"
              />
            </SettingField>
            <div>
              <SecretInput
                v-model="form.tencentAppSecretKey"
                :is-set="secretSet('tencentAppSecretKey')"
                :label="t('authGuards.settings.captcha.tencent.appSecretKey')"
              />
              <p v-if="err('tencentAppSecretKey')" class="mt-1 text-xs text-danger" role="alert">{{ err("tencentAppSecretKey") }}</p>
            </div>
            <div>
              <SecretInput
                v-model="form.tencentSecretId"
                :is-set="secretSet('tencentSecretId')"
                :label="t('authGuards.settings.captcha.tencent.secretId')"
              />
              <p v-if="err('tencentSecretId')" class="mt-1 text-xs text-danger" role="alert">{{ err("tencentSecretId") }}</p>
            </div>
            <div>
              <SecretInput
                v-model="form.tencentSecretKey"
                :is-set="secretSet('tencentSecretKey')"
                :label="t('authGuards.settings.captcha.tencent.secretKey')"
              />
              <p v-if="err('tencentSecretKey')" class="mt-1 text-xs text-danger" role="alert">{{ err("tencentSecretKey") }}</p>
            </div>
            <p class="hint sm:col-span-2">{{ t("authGuards.settings.captcha.tencent.help") }}</p>
          </div>

          <!-- Aliyun -->
          <div v-else class="grid gap-4 sm:grid-cols-2">
            <SettingField
              class="sm:col-span-2"
              :label="t('authGuards.settings.captcha.aliyun.region')"
              :dirty="isDirty('aliyunRegion')"
            >
              <SegmentedControl v-model="form.aliyunRegion" :options="aliyunRegions" size="md" />
            </SettingField>
            <SettingField
              input-id="cap-aliyun-prefix"
              :label="t('authGuards.settings.captcha.aliyun.prefix')"
              required
              :dirty="isDirty('aliyunPrefix')"
              :error="err('aliyunPrefix')"
            >
              <input
                id="cap-aliyun-prefix"
                v-model="form.aliyunPrefix"
                type="text"
                spellcheck="false"
                autocomplete="off"
                maxlength="128"
                class="input font-mono"
                :class="err('aliyunPrefix') ? errorClass : ''"
              />
            </SettingField>
            <SettingField
              input-id="cap-aliyun-scene"
              :label="t('authGuards.settings.captcha.aliyun.sceneId')"
              required
              :dirty="isDirty('aliyunSceneId')"
              :error="err('aliyunSceneId')"
            >
              <input
                id="cap-aliyun-scene"
                v-model="form.aliyunSceneId"
                type="text"
                spellcheck="false"
                autocomplete="off"
                maxlength="128"
                class="input font-mono"
                :class="err('aliyunSceneId') ? errorClass : ''"
              />
            </SettingField>
            <SettingField
              input-id="cap-aliyun-ak"
              :label="t('authGuards.settings.captcha.aliyun.accessKeyId')"
              required
              :dirty="isDirty('aliyunAccessKeyId')"
              :error="err('aliyunAccessKeyId')"
            >
              <input
                id="cap-aliyun-ak"
                v-model="form.aliyunAccessKeyId"
                type="text"
                spellcheck="false"
                autocomplete="off"
                maxlength="128"
                class="input font-mono"
                :class="err('aliyunAccessKeyId') ? errorClass : ''"
                placeholder="LTAI…"
              />
            </SettingField>
            <div>
              <SecretInput
                v-model="form.aliyunAccessKeySecret"
                :is-set="secretSet('aliyunAccessKeySecret')"
                :label="t('authGuards.settings.captcha.aliyun.accessKeySecret')"
              />
              <p v-if="err('aliyunAccessKeySecret')" class="mt-1 text-xs text-danger" role="alert">{{ err("aliyunAccessKeySecret") }}</p>
            </div>
            <p class="hint sm:col-span-2">{{ t("authGuards.settings.captcha.aliyun.help") }}</p>
          </div>

          <p class="flex items-start gap-1.5 rounded-lg bg-surface-2/50 px-3 py-2 text-2xs leading-relaxed text-fg-subtle">
            <UiIcon name="shield" :size="12" class="mt-0.5 shrink-0 text-success" />
            <span class="min-w-0">
              {{ t("authGuards.settings.captcha.saveCheck") }}
              <template v-if="completeness && completeness.done < completeness.total">
                · {{ t("authGuards.settings.captcha.completeness", completeness) }}
              </template>
            </span>
          </p>
        </div>
      </Transition>
    </UiCard>

    <div class="space-y-6 xl:col-span-2">
      <!-- Where to ask -->
      <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(1)" icon="sliders" :title="t('authGuards.settings.captcha.scopesTitle')">
        <template #actions>
          <span class="text-xs tabular-nums text-fg-subtle">{{ t("authGuards.settings.captcha.scopesCount", { n: scopesOn, total: CAPTCHA_SCOPE_KEYS.length }) }}</span>
        </template>
        <div class="divide-y divide-line/70 transition-opacity duration-200" :class="form.provider === 'none' ? 'opacity-60' : ''">
          <SettingSwitchRow
            v-for="s in CAPTCHA_SCOPE_KEYS"
            :key="s"
            v-model="form.scopes[s]"
            :icon="SCOPE_ICON[s]"
            tone="accent"
            :title="t(`authGuards.settings.captcha.scopes.${s}.title`)"
            :description="t(`authGuards.settings.captcha.scopes.${s}.desc`)"
            :dirty="scopeDirty(s)"
          />
        </div>
        <p v-if="form.provider === 'none'" class="mt-3 flex items-center gap-1.5 text-2xs text-fg-subtle">
          <UiIcon name="info" :size="11" />
          {{ t("authGuards.settings.captcha.scopesOff") }}
        </p>
      </UiCard>

      <!-- Tests -->
      <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(2)" icon="zap" :title="t('authGuards.settings.captcha.test.title')">
        <p class="text-xs leading-relaxed text-fg-subtle">{{ t("authGuards.settings.captcha.test.help") }}</p>
        <p v-if="credentialEdits" class="mt-2 flex items-start gap-1.5 text-2xs text-warning">
          <UiIcon name="alert" :size="11" class="mt-0.5 shrink-0" />
          {{ t("authGuards.settings.captcha.test.unsaved") }}
        </p>

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="!testProvider || testing !== null"
            :aria-busy="testing === 'credentials'"
            @click="testCredentials"
          >
            <UiIcon :name="testing === 'credentials' ? 'loader' : 'key'" :size="14" :spin="testing === 'credentials'" />
            {{ t("authGuards.settings.captcha.test.credentials") }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="!tryConfig"
            :aria-expanded="tryOpen"
            :title="tryConfig ? undefined : t('authGuards.settings.captcha.test.tryDisabled')"
            @click="tryOpen = !tryOpen"
          >
            <UiIcon name="play" :size="14" />
            {{ tryOpen ? t("authGuards.settings.captcha.test.tryClose") : t("authGuards.settings.captcha.test.try") }}
          </button>
        </div>

        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="opacity-0"
        >
          <div v-if="tryOpen && tryConfig" class="mt-4 space-y-3 rounded-xl border border-line bg-surface-2/30 p-3.5">
            <p class="text-2xs text-fg-subtle">{{ t("authGuards.settings.captcha.test.tryHelp") }}</p>
            <CaptchaWidget ref="tryWidget" :config="tryConfig" />
            <button
              type="button"
              class="btn btn-primary btn-sm w-full"
              :disabled="testing !== null"
              :aria-busy="testing === 'token'"
              @click="testChallenge"
            >
              <UiIcon :name="testing === 'token' ? 'loader' : 'check'" :size="14" :spin="testing === 'token'" />
              {{ t("authGuards.settings.captcha.test.verify") }}
            </button>
          </div>
        </Transition>

        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="opacity-0"
        >
          <UiAlert v-if="resultView" :key="`r-${resultView.title}`" :tone="resultView.tone" class="mt-4" :title="resultView.title">
            <span v-if="resultView.detail" class="break-all font-mono text-2xs">{{ resultView.detail }}</span>
          </UiAlert>
          <UiAlert v-else-if="testError" key="err" tone="danger" class="mt-4">{{ testError }}</UiAlert>
        </Transition>

        <p class="mt-4 flex items-start gap-1.5 border-t border-line/70 pt-3 text-2xs leading-relaxed text-fg-subtle">
          <UiIcon name="terminal" :size="12" class="mt-0.5 shrink-0" />
          <span class="min-w-0">
            {{ t("authGuards.settings.captcha.bypass") }}
            <code class="code-chip">SLIPGATE_CAPTCHA_BYPASS=1</code>
          </span>
        </p>
      </UiCard>
    </div>
  </div>
</template>
