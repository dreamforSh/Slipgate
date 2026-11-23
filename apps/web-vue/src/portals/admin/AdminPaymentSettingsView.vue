<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave, RouterLink } from "vue-router";
import {
  DEFAULT_PAYMENT_CONFIG,
  minorToFiat,
  type EasypayMethod,
  type EasypayMode,
  type LoadBalanceStrategy,
  type PaymentConfig,
  type PaymentCurrency,
  type UpdatePaymentConfigRequest,
} from "@slipgate/contracts";
import ChannelGlyph from "../../components/payments/ChannelGlyph.vue";
import PaymentInstancesCard from "../../components/payments/admin/PaymentInstancesCard.vue";
import SecretInput from "../../components/payments/SecretInput.vue";
import { creditNanoForMinor, currencySymbol, formatFiat, parseFiatInput } from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import SettingField from "../../components/settings/SettingField.vue";
import SettingSwitchRow from "../../components/settings/SettingSwitchRow.vue";
import SettingsSaveBar from "../../components/settings/SettingsSaveBar.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import MarkdownView from "../../components/ui/MarkdownView.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { apiJson, errorText } from "../../lib/api";
import { formatUsd, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const { channelLabel } = usePaymentLabels();
const toast = useToastStore();

const METHODS: EasypayMethod[] = ["alipay", "wxpay", "qqpay"];
const STRIPE_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
const INSTRUCTIONS_MAX = 4000;

/* ---------------- Draft ---------------- */

interface Draft {
  enabled: boolean;
  currency: PaymentCurrency;
  customAmountEnabled: boolean;
  /** Fiat per 1 USD, as typed ("7.20"). */
  rate: string;
  minAmount: string;
  maxAmount: string;
  orderTimeoutMinutes: number | string;
  maxPendingOrders: number | string;
  callbackBaseUrl: string;
  loadBalanceStrategy: LoadBalanceStrategy;
  easypayEnabled: boolean;
  easypayApiUrl: string;
  easypayPid: string;
  /** undefined = keep, "" = clear, value = replace. */
  easypayKey: string | undefined;
  easypayMethods: EasypayMethod[];
  easypayMode: EasypayMode;
  easypayRefundEnabled: boolean;
  easypayAllowUserRefund: boolean;
  stripeEnabled: boolean;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  stripeRefundEnabled: boolean;
  stripeAllowUserRefund: boolean;
  manualEnabled: boolean;
  manualInstructions: string;
  manualAllowUserRefund: boolean;
}

function fromConfig(c: PaymentConfig): Draft {
  return {
    enabled: c.enabled,
    currency: c.currency,
    customAmountEnabled: c.customAmountEnabled,
    rate: minorToFiat(c.minorPerUsd),
    minAmount: minorToFiat(c.minAmountMinor),
    maxAmount: minorToFiat(c.maxAmountMinor),
    orderTimeoutMinutes: c.orderTimeoutMinutes,
    maxPendingOrders: c.maxPendingOrders,
    callbackBaseUrl: c.callbackBaseUrl,
    loadBalanceStrategy: c.loadBalanceStrategy,
    easypayEnabled: c.easypay.enabled,
    easypayApiUrl: c.easypay.apiUrl,
    easypayPid: c.easypay.pid,
    easypayKey: undefined,
    easypayMethods: METHODS.filter((m) => c.easypay.methods.includes(m)),
    easypayMode: c.easypay.mode,
    easypayRefundEnabled: c.easypay.refundEnabled,
    easypayAllowUserRefund: c.easypay.allowUserRefund,
    stripeEnabled: c.stripe.enabled,
    stripeSecretKey: undefined,
    stripeWebhookSecret: undefined,
    stripeRefundEnabled: c.stripe.refundEnabled,
    stripeAllowUserRefund: c.stripe.allowUserRefund,
    manualEnabled: c.manual.enabled,
    manualInstructions: c.manual.instructions,
    manualAllowUserRefund: c.manual.allowUserRefund,
  };
}

const original = ref<PaymentConfig | null>(null);
const draft = reactive<Draft>(fromConfig(DEFAULT_PAYMENT_CONFIG));

const loading = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    const cfg = await apiJson<PaymentConfig>("/api/v1/admin/payments/config", {
      fallbackError: t("payments.admin.settings.loadFailed"),
    });
    original.value = cfg;
    Object.assign(draft, fromConfig(cfg));
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("payments.admin.settings.loadFailed"));
  } finally {
    loading.value = false;
  }
}

function reload() {
  if (dirtyCount.value && !window.confirm(t("payments.admin.settings.leaveConfirm"))) return;
  void load();
}

/* ---------------- Validation ---------------- */

const isHttp = (v: string) => v === "" || (/^https?:\/\//i.test(v) && v.length <= 512);
const intIn = (v: number | string, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return v !== "" && Number.isInteger(n) && n >= min && n <= max;
};

const rateMinor = computed(() => parseFiatInput(draft.rate));
const minMinor = computed(() => parseFiatInput(draft.minAmount));
const maxMinor = computed(() => parseFiatInput(draft.maxAmount));

const errors = computed(() => {
  const e: Partial<Record<"rate" | "min" | "max" | "timeout" | "maxPending" | "callback" | "apiUrl" | "methods", string>> = {};
  if (rateMinor.value === null || rateMinor.value < 1 || rateMinor.value > 100_000_000) {
    e.rate = t("payments.admin.settings.custom.errors.rate");
  }
  if (minMinor.value === null || minMinor.value < 1) e.min = t("payments.admin.settings.custom.errors.amount");
  if (maxMinor.value === null || maxMinor.value < 1) e.max = t("payments.admin.settings.custom.errors.amount");
  if (!e.min && !e.max && (minMinor.value ?? 0) > (maxMinor.value ?? 0)) e.max = t("payments.admin.settings.custom.errors.range");
  if (!intIn(draft.orderTimeoutMinutes, 5, 1440)) e.timeout = t("payments.admin.settings.general.errors.timeout");
  if (!intIn(draft.maxPendingOrders, 1, 50)) e.maxPending = t("payments.admin.settings.general.errors.maxPending");
  if (!isHttp(draft.callbackBaseUrl.trim())) e.callback = t("payments.admin.settings.callback.invalid");
  if (!isHttp(draft.easypayApiUrl.trim())) e.apiUrl = t("payments.admin.settings.callback.invalid");
  if (draft.easypayEnabled && draft.easypayMethods.length === 0) e.methods = t("payments.admin.settings.easypay.methodsHint");
  return e;
});
const hasErrors = computed(() => Object.keys(errors.value).length > 0);

/* ---------------- Diff → PATCH ---------------- */

const diff = computed<{ patch: UpdatePaymentConfigRequest; keys: string[] }>(() => {
  const c = original.value;
  const patch: UpdatePaymentConfigRequest = {};
  const keys: string[] = [];
  if (!c) return { patch, keys };
  const mark = (key: string) => keys.push(key);

  if (draft.enabled !== c.enabled) {
    patch.enabled = draft.enabled;
    mark("enabled");
  }
  if (draft.currency !== c.currency) {
    patch.currency = draft.currency;
    mark("currency");
  }
  if (draft.customAmountEnabled !== c.customAmountEnabled) {
    patch.customAmountEnabled = draft.customAmountEnabled;
    mark("customAmountEnabled");
  }
  if (rateMinor.value !== null && rateMinor.value !== c.minorPerUsd) {
    patch.minorPerUsd = rateMinor.value;
    mark("rate");
  }
  if (minMinor.value !== null && minMinor.value !== c.minAmountMinor) {
    patch.minAmountMinor = minMinor.value;
    mark("min");
  }
  if (maxMinor.value !== null && maxMinor.value !== c.maxAmountMinor) {
    patch.maxAmountMinor = maxMinor.value;
    mark("max");
  }
  const timeout = Number(draft.orderTimeoutMinutes);
  if (draft.orderTimeoutMinutes !== "" && timeout !== c.orderTimeoutMinutes) {
    patch.orderTimeoutMinutes = timeout;
    mark("timeout");
  }
  const pending = Number(draft.maxPendingOrders);
  if (draft.maxPendingOrders !== "" && pending !== c.maxPendingOrders) {
    patch.maxPendingOrders = pending;
    mark("maxPending");
  }
  const base = draft.callbackBaseUrl.trim();
  if (base !== c.callbackBaseUrl) {
    patch.callbackBaseUrl = base;
    mark("callback");
  }
  if (draft.loadBalanceStrategy !== c.loadBalanceStrategy) {
    patch.loadBalanceStrategy = draft.loadBalanceStrategy;
    mark("strategy");
  }

  const ep: NonNullable<UpdatePaymentConfigRequest["easypay"]> = {};
  if (draft.easypayEnabled !== c.easypay.enabled) {
    ep.enabled = draft.easypayEnabled;
    mark("easypay.enabled");
  }
  if (draft.easypayApiUrl.trim() !== c.easypay.apiUrl) {
    ep.apiUrl = draft.easypayApiUrl.trim();
    mark("easypay.apiUrl");
  }
  if (draft.easypayPid.trim() !== c.easypay.pid) {
    ep.pid = draft.easypayPid.trim();
    mark("easypay.pid");
  }
  if (draft.easypayKey !== undefined && !(draft.easypayKey === "" && !c.easypay.keySet)) {
    ep.key = draft.easypayKey;
    mark("easypay.key");
  }
  const methodsNow = METHODS.filter((m) => c.easypay.methods.includes(m)).join(",");
  if (draft.easypayMethods.join(",") !== methodsNow) {
    ep.methods = [...draft.easypayMethods];
    mark("easypay.methods");
  }
  if (draft.easypayMode !== c.easypay.mode) {
    ep.mode = draft.easypayMode;
    mark("easypay.mode");
  }
  if (draft.easypayRefundEnabled !== c.easypay.refundEnabled) {
    ep.refundEnabled = draft.easypayRefundEnabled;
    mark("easypay.refundEnabled");
  }
  if (draft.easypayAllowUserRefund !== c.easypay.allowUserRefund) {
    ep.allowUserRefund = draft.easypayAllowUserRefund;
    mark("easypay.allowUserRefund");
  }
  if (Object.keys(ep).length) patch.easypay = ep;

  const st: NonNullable<UpdatePaymentConfigRequest["stripe"]> = {};
  if (draft.stripeEnabled !== c.stripe.enabled) {
    st.enabled = draft.stripeEnabled;
    mark("stripe.enabled");
  }
  if (draft.stripeSecretKey !== undefined && !(draft.stripeSecretKey === "" && !c.stripe.secretKeySet)) {
    st.secretKey = draft.stripeSecretKey;
    mark("stripe.secretKey");
  }
  if (draft.stripeWebhookSecret !== undefined && !(draft.stripeWebhookSecret === "" && !c.stripe.webhookSecretSet)) {
    st.webhookSecret = draft.stripeWebhookSecret;
    mark("stripe.webhookSecret");
  }
  if (draft.stripeRefundEnabled !== c.stripe.refundEnabled) {
    st.refundEnabled = draft.stripeRefundEnabled;
    mark("stripe.refundEnabled");
  }
  if (draft.stripeAllowUserRefund !== c.stripe.allowUserRefund) {
    st.allowUserRefund = draft.stripeAllowUserRefund;
    mark("stripe.allowUserRefund");
  }
  if (Object.keys(st).length) patch.stripe = st;

  const mn: NonNullable<UpdatePaymentConfigRequest["manual"]> = {};
  if (draft.manualEnabled !== c.manual.enabled) {
    mn.enabled = draft.manualEnabled;
    mark("manual.enabled");
  }
  if (draft.manualInstructions !== c.manual.instructions) {
    mn.instructions = draft.manualInstructions;
    mark("manual.instructions");
  }
  if (draft.manualAllowUserRefund !== c.manual.allowUserRefund) {
    mn.allowUserRefund = draft.manualAllowUserRefund;
    mark("manual.allowUserRefund");
  }
  if (Object.keys(mn).length) patch.manual = mn;

  return { patch, keys };
});

const dirtyCount = computed(() => diff.value.keys.length);
const isDirty = (key: string) => diff.value.keys.includes(key);

async function save() {
  if (saving.value || !dirtyCount.value) return;
  if (hasErrors.value) {
    toast.error(t("payments.admin.settings.saveBar.invalid"));
    return;
  }
  saving.value = true;
  try {
    const cfg = await apiJson<PaymentConfig>("/api/v1/admin/payments/config", {
      method: "PATCH",
      body: diff.value.patch,
      fallbackError: t("payments.admin.settings.saveFailed"),
    });
    original.value = cfg;
    Object.assign(draft, fromConfig(cfg));
    toast.success(t("payments.admin.settings.saved"));
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.settings.saveFailed")));
  } finally {
    saving.value = false;
  }
}

function discard() {
  if (original.value) Object.assign(draft, fromConfig(original.value));
}

/* ---------------- Derived display ---------------- */

const symbol = computed(() => currencySymbol(draft.currency));

const example = computed(() => {
  const rate = rateMinor.value;
  if (rate === null || rate < 1) return null;
  const pay = 100 * 100;
  return t("payments.admin.settings.custom.example", {
    pay: formatFiat(pay, draft.currency),
    credit: formatUsd(creditNanoForMinor(pay, rate)),
  });
});

const portalOrigin = typeof window !== "undefined" ? window.location.origin : "";
const notifyBase = computed(() => (draft.callbackBaseUrl.trim() || portalOrigin).replace(/\/+$/, ""));
const notifyEstimated = computed(() => draft.callbackBaseUrl.trim() === "");
const notifyUrls = computed(() => [
  { key: "easypay", label: t("payments.admin.settings.callback.easypayNotify"), url: `${notifyBase.value}/webhooks/payment/easypay` },
  { key: "stripe", label: t("payments.admin.settings.callback.stripeNotify"), url: `${notifyBase.value}/webhooks/payment/stripe` },
  { key: "alipay", label: t("payFlow.settings.alipayNotify"), url: `${notifyBase.value}/webhooks/payment/alipay` },
  { key: "wxpay", label: t("payFlow.settings.wxpayNotify"), url: `${notifyBase.value}/webhooks/payment/wxpay` },
  { key: "airwallex", label: t("payFlow.settings.airwallexNotify"), url: `${notifyBase.value}/webhooks/payment/airwallex` },
]);

/** What a secret field will hold after saving. */
const effectiveSet = (value: string | undefined, isSet: boolean) => (value === undefined ? isSet : value !== "");

type ProviderState = { tone: Tone; text: string };
function providerState(enabled: boolean, complete: boolean): ProviderState {
  if (!enabled) return { tone: "neutral", text: t("payments.admin.settings.provider.off") };
  if (!complete) return { tone: "warning", text: t("payments.admin.settings.provider.incomplete") };
  return { tone: "success", text: t("payments.admin.settings.provider.ready") };
}

const easypayState = computed(() =>
  providerState(
    draft.easypayEnabled,
    Boolean(
      draft.easypayApiUrl.trim() &&
        draft.easypayPid.trim() &&
        draft.easypayMethods.length &&
        effectiveSet(draft.easypayKey, original.value?.easypay.keySet ?? false),
    ),
  ),
);
const stripeState = computed(() =>
  providerState(
    draft.stripeEnabled,
    effectiveSet(draft.stripeSecretKey, original.value?.stripe.secretKeySet ?? false) &&
      effectiveSet(draft.stripeWebhookSecret, original.value?.stripe.webhookSecretSet ?? false),
  ),
);
const manualState = computed(() => providerState(draft.manualEnabled, draft.manualInstructions.trim() !== ""));

function toggleMethod(m: EasypayMethod) {
  draft.easypayMethods = draft.easypayMethods.includes(m)
    ? draft.easypayMethods.filter((x) => x !== m)
    : METHODS.filter((x) => x === m || draft.easypayMethods.includes(x));
}

type ManualTab = "edit" | "preview";
const manualTab = ref<ManualTab>("edit");
const manualTabs = computed<{ value: ManualTab; label: string }[]>(() => [
  { value: "edit", label: t("payments.admin.settings.manual.edit") },
  { value: "preview", label: t("payments.admin.settings.manual.preview") },
]);

const strategyOptions = computed<{ value: LoadBalanceStrategy; label: string }[]>(() => [
  { value: "round-robin", label: t("payFlow.settings.roundRobin") },
  { value: "least-amount", label: t("payFlow.settings.leastAmount") },
]);

const easypayModeOptions = computed<{ value: EasypayMode; label: string }[]>(() => [
  { value: "popup", label: t("payFlow.settings.modePopup") },
  { value: "qrcode", label: t("payFlow.settings.modeQrcode") },
]);

const currencyOptions = computed<{ value: PaymentCurrency; label: string }[]>(() => [
  { value: "CNY", label: t("payments.currencies.CNY") },
  { value: "USD", label: t("payments.currencies.USD") },
]);

/* ---------------- Guards & shortcuts ---------------- */

function onKeydown(ev: KeyboardEvent) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    void save();
  }
}

function onBeforeUnload(ev: BeforeUnloadEvent) {
  if (!dirtyCount.value) return;
  ev.preventDefault();
  ev.returnValue = "";
}

onBeforeRouteLeave(() => {
  if (dirtyCount.value && !saving.value) return window.confirm(t("payments.admin.settings.leaveConfirm"));
  return true;
});

onMounted(() => {
  void load();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", onBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const enter = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";
const delay = (i: number) => ({ animationDelay: `${Math.min(i, 6) * 50}ms` });
const errorRing = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.paymentSettings')">
      <template #meta>
        <UiBadge v-if="original" :tone="original.enabled ? 'success' : 'neutral'" dot>
          {{ original.enabled ? t("payments.admin.settings.status.on") : t("payments.admin.settings.status.off") }}
        </UiBadge>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || saving" @click="reload">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <RouterLink to="/admin/payment-plans" class="btn btn-secondary">
          <UiIcon name="box" :size="15" />
          <span class="hidden sm:inline">{{ t("nav.paymentPlans") }}</span>
        </RouterLink>
      </template>
    </PageHeader>

    <UiAlert v-if="loadError && !original" tone="warning">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("common.refresh") }}
        </button>
      </template>
    </UiAlert>

    <div v-if="!original && loading" class="grid gap-6 xl:grid-cols-2" aria-busy="true">
      <div v-for="i in 4" :key="i" class="card h-64 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
    </div>

    <template v-else-if="original">
      <div class="grid items-start gap-6 xl:grid-cols-2">
        <!-- General -->
        <UiCard icon="sliders" :title="t('payments.admin.settings.general.title')" :class="enter" :style="delay(0)">
          <SettingSwitchRow
            v-model="draft.enabled"
            icon="credit-card"
            tone="success"
            :title="t('payments.admin.settings.general.enabled')"
            :description="t('payments.admin.settings.general.enabledHint')"
            :dirty="isDirty('enabled')"
          />
          <div class="mt-4 grid gap-4 border-t border-line/70 pt-4 sm:grid-cols-2">
            <SettingField
              class="sm:col-span-2"
              input-id="pay-currency"
              :label="t('payments.admin.settings.general.currency')"
              :hint="t('payments.admin.settings.general.currencyHint')"
              :dirty="isDirty('currency')"
            >
              <SegmentedControl v-model="draft.currency" :options="currencyOptions" size="md" block />
            </SettingField>
            <SettingField
              input-id="pay-timeout"
              :label="t('payments.admin.settings.general.timeout')"
              :hint="t('payments.admin.settings.general.timeoutHint')"
              :error="errors.timeout"
              :dirty="isDirty('timeout')"
            >
              <input
                id="pay-timeout"
                v-model.number="draft.orderTimeoutMinutes"
                type="number"
                min="5"
                max="1440"
                step="1"
                class="input tabular-nums"
                :class="errors.timeout ? errorRing : ''"
              />
            </SettingField>
            <SettingField
              input-id="pay-max-pending"
              :label="t('payments.admin.settings.general.maxPending')"
              :hint="t('payments.admin.settings.general.maxPendingHint')"
              :error="errors.maxPending"
              :dirty="isDirty('maxPending')"
            >
              <input
                id="pay-max-pending"
                v-model.number="draft.maxPendingOrders"
                type="number"
                min="1"
                max="50"
                step="1"
                class="input tabular-nums"
                :class="errors.maxPending ? errorRing : ''"
              />
            </SettingField>
            <SettingField
              class="sm:col-span-2"
              input-id="pay-strategy"
              :label="t('payFlow.settings.strategy')"
              :hint="t('payFlow.settings.strategyHint')"
              :dirty="isDirty('strategy')"
            >
              <SegmentedControl v-model="draft.loadBalanceStrategy" :options="strategyOptions" size="md" block />
            </SettingField>
          </div>
        </UiCard>

        <!-- Custom amounts -->
        <UiCard icon="wallet" :title="t('payments.admin.settings.custom.title')" :class="enter" :style="delay(1)">
          <SettingSwitchRow
            v-model="draft.customAmountEnabled"
            icon="sliders"
            tone="info"
            :title="t('payments.admin.settings.custom.enabled')"
            :description="t('payments.admin.settings.custom.enabledHint')"
            :dirty="isDirty('customAmountEnabled')"
          />
          <div class="mt-4 space-y-4 border-t border-line/70 pt-4">
            <SettingField
              input-id="pay-rate"
              :label="t('payments.admin.settings.custom.rate')"
              :hint="t('payments.admin.settings.custom.rateHint')"
              :error="errors.rate"
              :dirty="isDirty('rate')"
            >
              <div class="flex items-center gap-2">
                <div class="relative min-w-0 flex-1">
                  <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-fg-subtle">
                    {{ symbol }}
                  </span>
                  <input
                    id="pay-rate"
                    v-model="draft.rate"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="input pl-7 tabular-nums"
                    :class="errors.rate ? errorRing : ''"
                  />
                </div>
                <span class="shrink-0 text-xs text-fg-muted">{{ t("payments.admin.settings.custom.rateSuffix") }}</span>
              </div>
            </SettingField>
            <div class="grid gap-4 sm:grid-cols-2">
              <SettingField
                input-id="pay-min"
                :label="t('payments.admin.settings.custom.min')"
                :error="errors.min"
                :dirty="isDirty('min')"
              >
                <div class="relative">
                  <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-fg-subtle">
                    {{ symbol }}
                  </span>
                  <input
                    id="pay-min"
                    v-model="draft.minAmount"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="input pl-7 tabular-nums"
                    :class="errors.min ? errorRing : ''"
                  />
                </div>
              </SettingField>
              <SettingField
                input-id="pay-max"
                :label="t('payments.admin.settings.custom.max')"
                :error="errors.max"
                :dirty="isDirty('max')"
              >
                <div class="relative">
                  <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-fg-subtle">
                    {{ symbol }}
                  </span>
                  <input
                    id="pay-max"
                    v-model="draft.maxAmount"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="input pl-7 tabular-nums"
                    :class="errors.max ? errorRing : ''"
                  />
                </div>
              </SettingField>
            </div>
            <p v-if="example" class="flex items-center gap-2 rounded-lg bg-accent/[0.06] px-3 py-2 text-xs tabular-nums text-fg-muted">
              <UiIcon name="zap" :size="13" class="shrink-0 text-accent" />
              {{ example }}
            </p>
          </div>
        </UiCard>

        <!-- Callback URLs -->
        <UiCard icon="link" :title="t('payments.admin.settings.callback.title')" class="xl:col-span-2" :class="enter" :style="delay(2)">
          <div class="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <SettingField
              input-id="pay-callback"
              :label="t('payments.admin.settings.callback.base')"
              :hint="t('payments.admin.settings.callback.baseHint')"
              :error="errors.callback"
              :dirty="isDirty('callback')"
            >
              <input
                id="pay-callback"
                v-model="draft.callbackBaseUrl"
                type="url"
                maxlength="512"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="errors.callback ? errorRing : ''"
                :placeholder="t('payments.admin.settings.callback.basePlaceholder')"
              />
            </SettingField>
            <div class="min-w-0 space-y-3">
              <div v-for="n in notifyUrls" :key="n.key" class="min-w-0">
                <p class="label">{{ n.label }}</p>
                <div class="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-surface-2/50 py-1 pl-3 pr-1">
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg" :title="n.url">{{ n.url }}</code>
                  <CopyButton :text="n.url" size="sm" />
                </div>
              </div>
              <p v-if="notifyEstimated" class="flex gap-1.5 text-xs leading-relaxed text-warning">
                <UiIcon name="info" :size="13" class="mt-0.5 shrink-0" />
                {{ t("payments.admin.settings.callback.estimated") }}
              </p>
            </div>
          </div>
        </UiCard>

        <!-- Provider instances (saved per action, not by the save bar) -->
        <PaymentInstancesCard
          class="xl:col-span-2"
          :class="enter"
          :style="delay(3)"
          :currency="original.currency"
          :notify-base="notifyBase"
        />

        <!-- EasyPay -->
        <UiCard :class="enter" :style="delay(4)">
          <template #header>
            <div class="flex min-w-0 items-center gap-3">
              <span class="flex shrink-0 -space-x-2">
                <ChannelGlyph
                  v-for="m in METHODS"
                  :key="m"
                  provider="easypay"
                  :method="m"
                  size="sm"
                  class="ring-2 ring-surface"
                />
              </span>
              <div class="min-w-0">
                <h2 class="truncate text-sm font-semibold text-fg">{{ t("payments.admin.settings.easypay.title") }}</h2>
                <p class="truncate text-xs text-fg-subtle">{{ t("payments.admin.settings.easypay.desc") }}</p>
              </div>
            </div>
          </template>
          <template #actions>
            <UiBadge :tone="easypayState.tone" dot>{{ easypayState.text }}</UiBadge>
            <UiSwitch v-model="draft.easypayEnabled" :label="t('payments.admin.settings.easypay.enabled')" hide-label />
          </template>
          <div class="space-y-4 transition-opacity duration-200" :class="draft.easypayEnabled ? '' : 'opacity-60'">
            <UiAlert v-if="draft.currency !== 'CNY'" tone="warning">{{ t("payments.admin.settings.easypay.cnyOnly") }}</UiAlert>
            <SettingField
              input-id="pay-ep-url"
              :label="t('payments.admin.settings.easypay.apiUrl')"
              :error="errors.apiUrl"
              :dirty="isDirty('easypay.apiUrl')"
            >
              <input
                id="pay-ep-url"
                v-model="draft.easypayApiUrl"
                type="url"
                maxlength="512"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="errors.apiUrl ? errorRing : ''"
                :placeholder="t('payments.admin.settings.easypay.apiUrlPlaceholder')"
              />
            </SettingField>
            <SettingField input-id="pay-ep-pid" :label="t('payments.admin.settings.easypay.pid')" :dirty="isDirty('easypay.pid')">
              <input
                id="pay-ep-pid"
                v-model="draft.easypayPid"
                type="text"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
              />
            </SettingField>
            <SecretInput
              v-model="draft.easypayKey"
              :is-set="original.easypay.keySet"
              :label="t('payments.admin.settings.easypay.key')"
            />
            <SettingField
              :label="t('payments.admin.settings.easypay.methods')"
              :hint="t('payments.admin.settings.easypay.methodsHint')"
              :error="errors.methods"
              :dirty="isDirty('easypay.methods')"
            >
              <div class="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
                <button
                  v-for="m in METHODS"
                  :key="m"
                  type="button"
                  :aria-pressed="draft.easypayMethods.includes(m)"
                  class="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-[border-color,background-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  :class="
                    draft.easypayMethods.includes(m)
                      ? 'border-accent bg-accent/[0.06] text-fg'
                      : 'border-line text-fg-muted hover:border-line-strong hover:bg-surface-2/60'
                  "
                  @click="toggleMethod(m)"
                >
                  <ChannelGlyph provider="easypay" :method="m" size="xs" />
                  <span class="min-w-0 flex-1 truncate">{{ channelLabel("easypay", m) }}</span>
                  <UiIcon
                    name="check"
                    :size="13"
                    :stroke-width="2.6"
                    class="shrink-0 text-accent transition-[opacity,transform] duration-150"
                    :class="draft.easypayMethods.includes(m) ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
                  />
                </button>
              </div>
            </SettingField>
            <SettingField
              :label="t('payFlow.settings.easypayMode')"
              :hint="t('payFlow.settings.easypayModeHint')"
              :dirty="isDirty('easypay.mode')"
            >
              <SegmentedControl v-model="draft.easypayMode" :options="easypayModeOptions" size="md" block />
            </SettingField>
            <div class="divide-y divide-line/70 border-t border-line/70 pt-4">
              <SettingSwitchRow
                v-model="draft.easypayRefundEnabled"
                icon="rotate-ccw"
                tone="violet"
                :title="t('payFlow.settings.refundEnabled')"
                :description="t('payFlow.settings.refundEnabledHint')"
                :dirty="isDirty('easypay.refundEnabled')"
              />
              <SettingSwitchRow
                v-model="draft.easypayAllowUserRefund"
                icon="user"
                tone="info"
                :title="t('payFlow.settings.allowUserRefund')"
                :description="t('payFlow.settings.allowUserRefundHint')"
                :dirty="isDirty('easypay.allowUserRefund')"
              />
            </div>
          </div>
        </UiCard>

        <!-- Stripe -->
        <UiCard :class="enter" :style="delay(5)">
          <template #header>
            <div class="flex min-w-0 items-center gap-3">
              <ChannelGlyph provider="stripe" size="sm" />
              <div class="min-w-0">
                <h2 class="truncate text-sm font-semibold text-fg">{{ t("payments.admin.settings.stripe.title") }}</h2>
                <p class="truncate text-xs text-fg-subtle">{{ t("payments.admin.settings.stripe.desc") }}</p>
              </div>
            </div>
          </template>
          <template #actions>
            <UiBadge :tone="stripeState.tone" dot>{{ stripeState.text }}</UiBadge>
            <UiSwitch v-model="draft.stripeEnabled" :label="t('payments.admin.settings.stripe.enabled')" hide-label />
          </template>
          <div class="space-y-4 transition-opacity duration-200" :class="draft.stripeEnabled ? '' : 'opacity-60'">
            <SecretInput
              v-model="draft.stripeSecretKey"
              :is-set="original.stripe.secretKeySet"
              :label="t('payments.admin.settings.stripe.secretKey')"
              :placeholder="t('payments.admin.settings.stripe.secretKeyPlaceholder')"
            />
            <SecretInput
              v-model="draft.stripeWebhookSecret"
              :is-set="original.stripe.webhookSecretSet"
              :label="t('payments.admin.settings.stripe.webhookSecret')"
              :placeholder="t('payments.admin.settings.stripe.webhookSecretPlaceholder')"
            />
            <div class="rounded-lg border border-line bg-surface-2/40 p-3 text-xs leading-relaxed text-fg-muted">
              <p>{{ t("payments.admin.settings.stripe.events") }}</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <span v-for="ev in STRIPE_EVENTS" :key="ev" class="code-chip">{{ ev }}</span>
              </div>
              <div class="mt-3 flex min-w-0 items-center gap-1 rounded-md border border-line bg-surface py-0.5 pl-2.5 pr-0.5 dark:bg-surface-2/60">
                <code class="min-w-0 flex-1 truncate font-mono text-2xs text-fg" :title="notifyUrls[1]?.url">{{ notifyUrls[1]?.url }}</code>
                <CopyButton :text="notifyUrls[1]?.url ?? ''" />
              </div>
            </div>
            <p class="flex gap-1.5 text-2xs text-fg-subtle">
              <UiIcon name="lock" :size="12" class="mt-px shrink-0" />
              {{ t("payments.admin.settings.secret.hint") }}
            </p>
            <div class="divide-y divide-line/70 border-t border-line/70 pt-4">
              <SettingSwitchRow
                v-model="draft.stripeRefundEnabled"
                icon="rotate-ccw"
                tone="violet"
                :title="t('payFlow.settings.refundEnabled')"
                :description="t('payFlow.settings.refundEnabledHint')"
                :dirty="isDirty('stripe.refundEnabled')"
              />
              <SettingSwitchRow
                v-model="draft.stripeAllowUserRefund"
                icon="user"
                tone="info"
                :title="t('payFlow.settings.allowUserRefund')"
                :description="t('payFlow.settings.allowUserRefundHint')"
                :dirty="isDirty('stripe.allowUserRefund')"
              />
            </div>
          </div>
        </UiCard>

        <!-- Manual transfer -->
        <UiCard class="xl:col-span-2" :class="enter" :style="delay(6)">
          <template #header>
            <div class="flex min-w-0 items-center gap-3">
              <ChannelGlyph provider="manual" size="sm" />
              <div class="min-w-0">
                <h2 class="truncate text-sm font-semibold text-fg">{{ t("payments.admin.settings.manual.title") }}</h2>
                <p class="truncate text-xs text-fg-subtle">{{ t("payments.admin.settings.manual.desc") }}</p>
              </div>
            </div>
          </template>
          <template #actions>
            <UiBadge :tone="manualState.tone" dot>{{ manualState.text }}</UiBadge>
            <UiSwitch v-model="draft.manualEnabled" :label="t('payments.admin.settings.manual.enabled')" hide-label />
          </template>
          <div class="transition-opacity duration-200" :class="draft.manualEnabled ? '' : 'opacity-60'">
            <SettingField
              input-id="pay-manual"
              :label="t('payments.admin.settings.manual.instructions')"
              :hint="t('payments.admin.settings.manual.instructionsHint')"
              :dirty="isDirty('manual.instructions')"
            >
              <template #aside>
                <div class="flex items-center gap-2">
                  <span
                    class="text-2xs tabular-nums"
                    :class="draft.manualInstructions.length > INSTRUCTIONS_MAX * 0.9 ? 'text-warning' : 'text-fg-subtle'"
                  >
                    {{ draft.manualInstructions.length }} / {{ INSTRUCTIONS_MAX }}
                  </span>
                  <SegmentedControl v-model="manualTab" :options="manualTabs" />
                </div>
              </template>
              <textarea
                v-if="manualTab === 'edit'"
                id="pay-manual"
                v-model="draft.manualInstructions"
                rows="8"
                :maxlength="INSTRUCTIONS_MAX"
                class="textarea font-mono text-xs"
                :placeholder="t('payments.admin.settings.manual.instructionsPlaceholder')"
              />
              <div v-else class="min-h-[12.5rem] rounded-lg border border-line bg-surface p-4 dark:bg-surface-2/40">
                <MarkdownView v-if="draft.manualInstructions.trim()" :source="draft.manualInstructions" />
                <p v-else class="text-xs text-fg-subtle">{{ t("payments.admin.settings.manual.previewEmpty") }}</p>
              </div>
            </SettingField>
            <div class="mt-4 border-t border-line/70 pt-4">
              <SettingSwitchRow
                v-model="draft.manualAllowUserRefund"
                icon="user"
                tone="info"
                :title="t('payFlow.settings.allowUserRefund')"
                :description="t('payFlow.settings.manualAllowUserRefundHint')"
                :dirty="isDirty('manual.allowUserRefund')"
              />
            </div>
          </div>
        </UiCard>
      </div>

      <SettingsSaveBar
        :show="dirtyCount > 0"
        :count="dirtyCount"
        :saving="saving"
        :invalid="hasErrors"
        @save="save"
        @discard="discard"
      />
    </template>
  </div>
</template>
