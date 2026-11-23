<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  PAYMENT_INSTANCE_TYPES,
  type CreatePaymentInstanceRequest,
  type PaymentCurrency,
  type PaymentInstanceProvider,
  type PaymentProviderInstance,
  type UpdatePaymentInstanceRequest,
} from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import SettingSwitchRow from "../../settings/SettingSwitchRow.vue";
import CopyButton from "../../ui/CopyButton.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import ChannelGlyph from "../ChannelGlyph.vue";
import SecretInput from "../SecretInput.vue";
import { usePayErrors } from "../paymentFlow";
import { currencySymbol } from "../paymentUtil";
import { usePaymentLabels } from "../usePaymentLabels";
import {
  CONFIG_FIELDS,
  configBody,
  draftFromInstance,
  emptyDraft,
  isRequiredSecret,
  limitMinor,
  limitsBody,
  PEM_SECRETS,
  secretFields,
  secretsBody,
  type ConfigField,
  type InstanceDraft,
  type LimitDraft,
} from "./instanceForm";
import SecretPemInput from "./SecretPemInput.vue";

/**
 * Create / edit one payment provider instance: its merchant settings, write-only secrets, the
 * methods it serves with per-method limits, refund flags and the callback URL to register.
 */
const props = defineProps<{
  open: boolean;
  /** Set when editing; otherwise `provider` says what is being added. */
  instance: PaymentProviderInstance | null;
  provider: PaymentInstanceProvider;
  /** Settlement currency (limits are typed in it). */
  currency: PaymentCurrency;
  /** Public base of the callback URLs. */
  notifyBase: string;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "saved", item: PaymentProviderInstance): void }>();

const { t } = useI18n();
const { providerLabel, channelLabel } = usePaymentLabels();
const toast = useToastStore();
const payError = usePayErrors();

const draft = reactive<InstanceDraft>(emptyDraft("easypay"));
const tried = ref(false);
const saving = ref(false);
const serverError = ref<string | null>(null);

const editing = computed(() => props.instance !== null);
const prov = computed<PaymentInstanceProvider>(() => props.instance?.provider ?? props.provider);
const secretsSet = computed<Record<string, boolean>>(() => props.instance?.secretsSet ?? {});

watch(
  () => [props.open, props.instance?.id, props.provider] as const,
  ([open]) => {
    if (!open) return;
    Object.assign(draft, props.instance ? draftFromInstance(props.instance) : emptyDraft(props.provider));
    if (!props.instance) draft.name = providerLabel(props.provider);
    tried.value = false;
    serverError.value = null;
  },
  { immediate: true },
);

const title = computed(() =>
  editing.value
    ? t("payFlow.instances.editor.editTitle", { name: props.instance?.name ?? "" })
    : t("payFlow.instances.editor.createTitle", { provider: providerLabel(props.provider) }),
);

/* ---------------- Fields ---------------- */

const fields = computed(() => CONFIG_FIELDS[prov.value]);
const secrets = computed(() => secretFields(prov.value));
const allTypes = computed(() => PAYMENT_INSTANCE_TYPES[prov.value]);
const symbol = computed(() => currencySymbol(props.currency));

const fieldLabel = (key: string) => t(`payFlow.instances.fields.${key}`);
const optionLabel = (f: ConfigField, v: string) => {
  if (f.kind === "modes") return t(`payFlow.instances.modes.${v}`);
  if (f.key === "env") return t(`payFlow.instances.envs.${v}`);
  if (f.key === "currency") return v === "" ? t("payFlow.instances.fields.currencyAny") : v;
  return v;
};

function secretHint(field: string): string {
  if (field === "privateKey" && prov.value === "alipay") return t("payFlow.instances.secretHints.alipayPrivateKey");
  if (field === "privateKey" && prov.value === "wxpay") return t("payFlow.instances.secretHints.wxpayPrivateKey");
  if (field === "mpAppSecret") return t("payFlow.instances.secretHints.mpAppSecret");
  return "";
}

const textValue = (key: string) => String(draft.config[key] ?? "");
function setText(key: string, ev: Event) {
  draft.config[key] = (ev.target as HTMLInputElement | HTMLTextAreaElement).value;
}

const modeList = (key: string): string[] => (Array.isArray(draft.config[key]) ? (draft.config[key] as string[]) : []);
function toggleMode(f: ConfigField, v: string) {
  const now = modeList(f.key);
  const next = now.includes(v) ? now.filter((x) => x !== v) : [...now, v];
  // Keep the schema's order so diffs stay stable.
  draft.config[f.key] = (f.options ?? []).filter((o) => next.includes(o));
}

function selectOptions(f: ConfigField) {
  return (f.options ?? []).map((v) => ({ value: v, label: optionLabel(f, v) }));
}

function toggleType(type: string) {
  const next = draft.supportedTypes.includes(type) ? draft.supportedTypes.filter((x) => x !== type) : [...draft.supportedTypes, type];
  draft.supportedTypes = allTypes.value.filter((x) => next.includes(x));
}

const LIMIT_KEYS = ["daily", "min", "max"] as const;
const LIMIT_LABELS: Record<(typeof LIMIT_KEYS)[number], string> = {
  daily: "payFlow.instances.editor.dailyLimit",
  min: "payFlow.instances.editor.singleMin",
  max: "payFlow.instances.editor.singleMax",
};

/** The limit draft of a method (created on first use). */
function limitOf(type: string): LimitDraft {
  draft.limits[type] ??= { daily: "", min: "", max: "" };
  return draft.limits[type]!;
}

const modeOptions = computed<{ value: "popup" | "qrcode"; label: string }[]>(() => [
  { value: "popup", label: t("payFlow.settings.modePopup") },
  { value: "qrcode", label: t("payFlow.settings.modeQrcode") },
]);

/* ---------------- Validation ---------------- */

const isUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v);

const errors = computed(() => {
  const e: Record<string, string> = {};
  if (!draft.name.trim()) e.name = t("payFlow.instances.editor.required", { field: t("payFlow.instances.editor.name") });
  for (const f of fields.value) {
    const v = draft.config[f.key];
    if (f.kind === "modes") {
      if (modeList(f.key).length === 0) e[f.key] = t("payFlow.instances.editor.typesHint");
      continue;
    }
    if (f.kind === "switch" || f.kind === "select") continue;
    const text = String(v ?? "").trim();
    if (f.required && !text) e[f.key] = t("payFlow.instances.editor.required", { field: fieldLabel(f.key) });
    else if (f.kind === "url" && text && !isUrl(text)) e[f.key] = t("payFlow.instances.editor.invalidUrl");
    else if (f.kind === "country" && !/^[A-Za-z]{2}$/.test(text)) e[f.key] = t("payFlow.instances.editor.invalidCountry");
  }
  const v3 = draft.secrets.apiV3Key;
  if (prov.value === "wxpay" && v3 && new TextEncoder().encode(v3.trim()).length !== 32) e.apiV3Key = t("payFlow.instances.editor.apiV3Length");
  if (draft.supportedTypes.length === 0) e.types = t("payFlow.instances.editor.typesHint");
  for (const type of draft.supportedTypes) {
    const l = draft.limits[type];
    if (!l) continue;
    const daily = limitMinor(l.daily);
    const min = limitMinor(l.min);
    const max = limitMinor(l.max);
    if (daily === null || min === null || max === null) e[`limit.${type}`] = t("payFlow.instances.editor.invalidAmount");
    else if (min > 0 && max > 0 && min > max) e[`limit.${type}`] = t("payFlow.instances.editor.minOverMax");
  }
  return e;
});
const shownError = (key: string) => (tried.value ? (errors.value[key] ?? null) : null);

/* ---------------- Save ---------------- */

async function save() {
  tried.value = true;
  serverError.value = null;
  if (Object.keys(errors.value).length > 0 || saving.value) return;
  saving.value = true;
  const common = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    supportedTypes: [...draft.supportedTypes],
    paymentMode: prov.value === "easypay" ? draft.paymentMode : "",
    refundEnabled: draft.refundEnabled,
    allowUserRefund: draft.allowUserRefund,
    limits: limitsBody(draft),
    config: configBody(draft),
    secrets: secretsBody(draft, secretsSet.value),
  };
  try {
    let item: PaymentProviderInstance;
    if (props.instance) {
      const body: UpdatePaymentInstanceRequest = common;
      item = (
        await apiJson<{ item: PaymentProviderInstance }>(`/api/v1/admin/payments/providers/${encodeURIComponent(props.instance.id)}`, {
          method: "PUT",
          body,
        })
      ).item;
      toast.success(t("payFlow.instances.editor.saved"));
    } else {
      const body: CreatePaymentInstanceRequest = { ...common, provider: prov.value, sortOrder: 0 };
      item = (await apiJson<{ item: PaymentProviderInstance }>("/api/v1/admin/payments/providers", { method: "POST", body })).item;
      toast.success(t("payFlow.instances.editor.created"));
    }
    emit("saved", item);
    emit("update:open", false);
  } catch (err) {
    serverError.value = payError(err, t("payFlow.instances.saveFailed"));
  } finally {
    saving.value = false;
  }
}

/* ---------------- Callback hints ---------------- */

const notifyUrl = computed(() => `${props.notifyBase}/webhooks/payment/${prov.value}`);
const oauthUrl = computed(() => `${props.notifyBase}/payment/wechat/callback`);
const jsapiOn = computed(() => prov.value === "wxpay" && modeList("modes").includes("jsapi"));
const errorRing = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <UiDrawer :open="open" width="lg" :title="title" @update:open="(v) => (!saving || v) && emit('update:open', v)">
    <form id="payment-instance-form" class="space-y-7" novalidate @submit.prevent="save">
      <div class="flex items-center gap-3 rounded-xl border border-line bg-surface-2/40 p-3.5">
        <ChannelGlyph :provider="prov === 'easypay' ? 'easypay' : prov" :method="prov === 'easypay' ? 'alipay' : null" />
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-fg">{{ providerLabel(prov) }}</p>
          <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ t(`payFlow.instances.providerDesc.${prov}`) }}</p>
        </div>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="serverError" tone="danger">{{ serverError }}</UiAlert>
      </Transition>

      <!-- Basics -->
      <section class="space-y-4">
        <h3 class="eyebrow">{{ t("payFlow.instances.editor.basics") }}</h3>
        <div>
          <label for="pi-name" class="label">{{ t("payFlow.instances.editor.name") }} <span class="text-danger">*</span></label>
          <input
            id="pi-name"
            v-model="draft.name"
            type="text"
            maxlength="64"
            autocomplete="off"
            class="input"
            :class="shownError('name') ? errorRing : ''"
            :placeholder="t('payFlow.instances.editor.namePlaceholder')"
            :aria-invalid="Boolean(shownError('name'))"
          />
          <p v-if="shownError('name')" class="mt-1 text-xs text-danger" role="alert">{{ shownError("name") }}</p>
        </div>
        <SettingSwitchRow
          v-model="draft.enabled"
          icon="zap"
          tone="success"
          :title="t('payFlow.instances.editor.enabled')"
          :description="t('payFlow.instances.editor.enabledHint')"
        />
      </section>

      <!-- Merchant settings -->
      <section v-if="fields.length" class="space-y-4">
        <h3 class="eyebrow">{{ t("payFlow.instances.editor.credentials") }}</h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <div v-for="f in fields" :key="f.key" class="min-w-0" :class="f.wide || f.kind === 'pem' || f.kind === 'modes' ? 'sm:col-span-2' : ''">
            <!-- Switch -->
            <div v-if="f.kind === 'switch'" class="flex h-full items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div class="min-w-0">
                <p class="text-xs font-medium text-fg">{{ fieldLabel(f.key) }}</p>
                <p v-if="f.hint" class="mt-0.5 text-2xs text-fg-subtle">{{ t(`payFlow.instances.fields.${f.hint}`) }}</p>
              </div>
              <UiSwitch
                :model-value="Boolean(draft.config[f.key])"
                tone="accent"
                :label="fieldLabel(f.key)"
                hide-label
                @update:model-value="draft.config[f.key] = $event"
              />
            </div>

            <!-- Modes (multi-select chips) -->
            <template v-else-if="f.kind === 'modes'">
              <p class="label">{{ fieldLabel(f.key) }}</p>
              <div class="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3" role="group" :aria-label="fieldLabel(f.key)">
                <button
                  v-for="opt in f.options"
                  :key="opt"
                  type="button"
                  :aria-pressed="modeList(f.key).includes(opt)"
                  class="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-[border-color,background-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  :class="
                    modeList(f.key).includes(opt)
                      ? 'border-accent bg-accent/[0.06] text-fg'
                      : 'border-line text-fg-muted hover:border-line-strong hover:bg-surface-2/60'
                  "
                  @click="toggleMode(f, opt)"
                >
                  <span class="min-w-0 flex-1 truncate">{{ optionLabel(f, opt) }}</span>
                  <UiIcon
                    name="check"
                    :size="13"
                    :stroke-width="2.6"
                    class="shrink-0 text-accent transition-[opacity,transform] duration-150"
                    :class="modeList(f.key).includes(opt) ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
                  />
                </button>
              </div>
              <p v-if="shownError(f.key)" class="mt-1 text-xs text-danger" role="alert">{{ shownError(f.key) }}</p>
              <p v-else-if="f.hint" class="hint">{{ t(`payFlow.instances.fields.${f.hint}`) }}</p>
            </template>

            <!-- Select (segmented) -->
            <template v-else-if="f.kind === 'select'">
              <p class="label">{{ fieldLabel(f.key) }}</p>
              <SegmentedControl
                :model-value="String(draft.config[f.key] ?? '')"
                :options="selectOptions(f)"
                block
                @update:model-value="draft.config[f.key] = $event"
              />
              <p v-if="f.hint" class="hint">{{ t(`payFlow.instances.fields.${f.hint}`) }}</p>
            </template>

            <!-- PEM (public keys) -->
            <template v-else-if="f.kind === 'pem'">
              <label :for="`pi-${f.key}`" class="label">
                {{ fieldLabel(f.key) }} <span v-if="f.required" class="text-danger">*</span>
              </label>
              <textarea
                :id="`pi-${f.key}`"
                :value="textValue(f.key)"
                rows="4"
                :maxlength="f.max"
                spellcheck="false"
                autocomplete="off"
                class="textarea font-mono text-2xs leading-snug"
                :class="shownError(f.key) ? errorRing : ''"
                :placeholder="t('payFlow.instances.pem.publicPlaceholder')"
                :aria-invalid="Boolean(shownError(f.key))"
                @input="setText(f.key, $event)"
              />
              <p v-if="shownError(f.key)" class="mt-1 text-xs text-danger" role="alert">{{ shownError(f.key) }}</p>
              <p v-else-if="f.hint" class="hint">{{ t(`payFlow.instances.fields.${f.hint}`) }}</p>
            </template>

            <!-- Text / URL / country -->
            <template v-else>
              <label :for="`pi-${f.key}`" class="label">
                {{ fieldLabel(f.key) }} <span v-if="f.required" class="text-danger">*</span>
              </label>
              <input
                :id="`pi-${f.key}`"
                :value="textValue(f.key)"
                :type="f.kind === 'url' ? 'url' : 'text'"
                :maxlength="f.kind === 'country' ? 2 : f.max"
                spellcheck="false"
                autocomplete="off"
                class="input font-mono text-xs"
                :class="[shownError(f.key) ? errorRing : '', f.kind === 'country' ? 'uppercase' : '']"
                :aria-invalid="Boolean(shownError(f.key))"
                @input="setText(f.key, $event)"
              />
              <p v-if="shownError(f.key)" class="mt-1 text-xs text-danger" role="alert">{{ shownError(f.key) }}</p>
              <p v-else-if="f.hint" class="hint">{{ t(`payFlow.instances.fields.${f.hint}`) }}</p>
            </template>
          </div>
        </div>
      </section>

      <!-- Secrets -->
      <section class="space-y-4">
        <div>
          <h3 class="eyebrow">{{ t("payFlow.instances.editor.secrets") }}</h3>
          <p class="mt-1 flex gap-1.5 text-2xs text-fg-subtle">
            <UiIcon name="lock" :size="12" class="mt-px shrink-0" />
            {{ t("payFlow.instances.editor.secretsHint") }}
          </p>
        </div>
        <template v-for="field in secrets" :key="field">
          <SecretPemInput
            v-if="PEM_SECRETS.has(field)"
            v-model="draft.secrets[field]"
            :is-set="Boolean(secretsSet[field])"
            :label="t(`payFlow.instances.secrets.${field}`)"
            :hint="secretHint(field)"
            :required="isRequiredSecret(prov, field)"
            :placeholder="t('payFlow.instances.pem.placeholder')"
          />
          <div v-else>
            <SecretInput
              v-model="draft.secrets[field]"
              :is-set="Boolean(secretsSet[field])"
              :label="t(`payFlow.instances.secrets.${field}`)"
            />
            <p v-if="shownError(field)" class="mt-1 text-xs text-danger" role="alert">{{ shownError(field) }}</p>
            <p v-else-if="secretHint(field)" class="hint">{{ secretHint(field) }}</p>
          </div>
        </template>
      </section>

      <!-- Methods & limits -->
      <section class="space-y-4">
        <div>
          <h3 class="eyebrow">{{ t("payFlow.instances.editor.channels") }}</h3>
          <p class="mt-1 text-2xs leading-relaxed text-fg-subtle">{{ t("payFlow.instances.editor.channelsHint") }}</p>
        </div>

        <div v-if="prov === 'easypay'" class="grid gap-4 sm:grid-cols-2">
          <div class="min-w-0 sm:col-span-2">
            <p class="label">{{ t("payFlow.instances.editor.types") }}</p>
            <div class="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3" role="group" :aria-label="t('payFlow.instances.editor.types')">
              <button
                v-for="type in allTypes"
                :key="type"
                type="button"
                :aria-pressed="draft.supportedTypes.includes(type)"
                class="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-[border-color,background-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                :class="
                  draft.supportedTypes.includes(type)
                    ? 'border-accent bg-accent/[0.06] text-fg'
                    : 'border-line text-fg-muted hover:border-line-strong hover:bg-surface-2/60'
                "
                @click="toggleType(type)"
              >
                <ChannelGlyph provider="easypay" :method="type" size="xs" />
                <span class="min-w-0 flex-1 truncate">{{ channelLabel("easypay", type) }}</span>
                <UiIcon
                  name="check"
                  :size="13"
                  :stroke-width="2.6"
                  class="shrink-0 text-accent transition-[opacity,transform] duration-150"
                  :class="draft.supportedTypes.includes(type) ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
                />
              </button>
            </div>
            <p v-if="shownError('types')" class="mt-1 text-xs text-danger" role="alert">{{ shownError("types") }}</p>
          </div>
          <div class="min-w-0 sm:col-span-2">
            <p class="label">{{ t("payFlow.instances.editor.mode") }}</p>
            <SegmentedControl v-model="draft.paymentMode" :options="modeOptions" size="md" block />
            <p class="hint">{{ t("payFlow.settings.easypayModeHint") }}</p>
          </div>
        </div>

        <TransitionGroup
          tag="div"
          class="space-y-3"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          leave-to-class="opacity-0"
        >
          <div v-for="type in draft.supportedTypes" :key="type" class="rounded-xl border border-line p-3.5">
            <p class="flex items-center gap-2 text-xs font-semibold text-fg">
              <ChannelGlyph :provider="prov === 'easypay' ? 'easypay' : prov" :method="prov === 'easypay' ? type : null" size="xs" />
              {{ channelLabel(prov === "easypay" ? "easypay" : prov, prov === "easypay" ? type : null) }}
              <span v-if="prov !== 'easypay'" class="font-normal text-fg-subtle">· {{ t("payFlow.instances.editor.fixedType") }}</span>
            </p>
            <div class="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
              <label v-for="k in LIMIT_KEYS" :key="k" class="min-w-0">
                <span class="mb-1 block text-2xs font-medium text-fg-muted">{{ t(LIMIT_LABELS[k]) }}</span>
                <span class="relative block">
                  <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-fg-subtle">{{ symbol }}</span>
                  <input
                    v-model="limitOf(type)[k]"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="input input-sm pl-6 tabular-nums"
                    :class="shownError(`limit.${type}`) ? errorRing : ''"
                    :placeholder="t('payFlow.instances.editor.unlimited')"
                  />
                </span>
              </label>
            </div>
            <p v-if="shownError(`limit.${type}`)" class="mt-1.5 text-xs text-danger" role="alert">{{ shownError(`limit.${type}`) }}</p>
          </div>
        </TransitionGroup>
      </section>

      <!-- Refunds -->
      <section>
        <h3 class="eyebrow">{{ t("payFlow.instances.editor.refunds") }}</h3>
        <div class="mt-3 divide-y divide-line/70">
          <SettingSwitchRow
            v-model="draft.refundEnabled"
            icon="rotate-ccw"
            tone="violet"
            class="!py-3 first:!pt-0"
            :title="t('payFlow.instances.editor.refundEnabled')"
            :description="t('payFlow.instances.editor.refundEnabledHint')"
          />
          <SettingSwitchRow
            v-model="draft.allowUserRefund"
            icon="user"
            tone="info"
            class="!py-3 last:!pb-0"
            :title="t('payFlow.instances.editor.allowUserRefund')"
            :description="t('payFlow.instances.editor.allowUserRefundHint')"
          />
        </div>
      </section>

      <!-- Callback -->
      <section class="space-y-3">
        <h3 class="eyebrow">{{ t("payFlow.instances.editor.notify") }}</h3>
        <p class="text-2xs text-fg-subtle">{{ t("payFlow.instances.editor.notifyHint") }}</p>
        <div class="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-surface-2/50 py-1 pl-3 pr-1">
          <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg" :title="notifyUrl">{{ notifyUrl }}</code>
          <CopyButton :text="notifyUrl" size="sm" />
        </div>
        <p v-if="prov === 'stripe'" class="text-2xs leading-relaxed text-fg-subtle">{{ t("payFlow.instances.editor.stripeEvents") }}</p>
        <p v-if="prov === 'airwallex'" class="text-2xs leading-relaxed text-fg-subtle">{{ t("payFlow.instances.editor.airwallexEvents") }}</p>
        <template v-if="jsapiOn">
          <p class="pt-1 text-xs font-medium text-fg-muted">{{ t("payFlow.instances.editor.oauthRedirect") }}</p>
          <p class="text-2xs text-fg-subtle">{{ t("payFlow.instances.editor.oauthHint") }}</p>
          <div class="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-surface-2/50 py-1 pl-3 pr-1">
            <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg" :title="oauthUrl">{{ oauthUrl }}</code>
            <CopyButton :text="oauthUrl" size="sm" />
          </div>
        </template>
      </section>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="payment-instance-form" class="btn btn-primary" :disabled="saving">
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ editing ? t("payFlow.instances.editor.save") : t("payFlow.instances.editor.create") }}
      </button>
    </template>
  </UiDrawer>
</template>
