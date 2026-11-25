<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { GroupItem, ModelPricingRule, UpsertModelPricingRule } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { ApiError, apiJson, errorText } from "../../../lib/api";
import { formatNumber, formatUsd } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import {
  builtinTierFor,
  cacheIsDefault,
  clampTokens,
  defaultCacheRead,
  defaultCacheWrite,
  formatPerM,
  isPrefixPattern,
  matchPricingRule,
  multiplierText,
  nanoToUsdText,
  normalizePriceInput,
  normalizeUnitPriceInput,
  parsePriceInput,
  partCost,
  PATTERN_MAX,
  PATTERN_RE,
  patternStem,
  rulePrices,
  sampleCost,
  TOKENS_MAX,
  type RulePreset,
} from "./pricingUtil";
import UiSelect from "../../ui/UiSelect.vue";

/** Create / edit a pricing rule, with a live cost preview for a sample request. */
const props = defineProps<{
  open: boolean;
  /** Rule being edited; null creates a new one. */
  rule: ModelPricingRule | null;
  /** Initial values for a new rule (tester / built-in override). */
  preset: RulePreset | null;
  rules: ModelPricingRule[];
  groups: GroupItem[];
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "saved", item: ModelPricingRule, created: boolean): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const form = reactive({
  pattern: "",
  input: "",
  output: "",
  cacheRead: "",
  cacheWrite: "",
  perRequest: "",
  perImage: "",
  perVideoSecond: "",
  longContextThresholdTokens: "",
  longContextInputMultiplier: "",
  longContextOutputMultiplier: "",
  serviceTierFastMultiplier: "",
  serviceTierFlexMultiplier: "",
  enabled: true,
  notes: "",
});
const showAdvanced = ref(false);
const submitted = ref(false);
const saving = ref(false);
const conflict = ref<string | null>(null);

const sample = reactive({ inputTokens: 10_000, outputTokens: 1_000, groupId: "" });

function init() {
  submitted.value = false;
  saving.value = false;
  conflict.value = null;
  const r = props.rule;
  if (r) {
    const p = rulePrices(r);
    const d = cacheIsDefault(p);
    const hasAdv = Boolean(
      (r.perRequestNanoUsd && r.perRequestNanoUsd !== "0") ||
        (r.perImageNanoUsd && r.perImageNanoUsd !== "0") ||
        (r.perVideoSecondNanoUsd && r.perVideoSecondNanoUsd !== "0") ||
        (r.longContextThresholdTokens && r.longContextThresholdTokens > 0) ||
        r.serviceTierFastMultiplier !== undefined ||
        r.serviceTierFlexMultiplier !== undefined,
    );
    showAdvanced.value = hasAdv;
    Object.assign(form, {
      pattern: r.pattern,
      input: nanoToUsdText(p.input),
      output: nanoToUsdText(p.output),
      // Default-derived cache prices stay empty so they keep following the input price.
      cacheRead: d.read ? "" : nanoToUsdText(p.cacheRead),
      cacheWrite: d.write ? "" : nanoToUsdText(p.cacheWrite),
      perRequest: r.perRequestNanoUsd && r.perRequestNanoUsd !== "0" ? nanoToUsdText(BigInt(r.perRequestNanoUsd)) : "",
      perImage: r.perImageNanoUsd && r.perImageNanoUsd !== "0" ? nanoToUsdText(BigInt(r.perImageNanoUsd)) : "",
      perVideoSecond:
        r.perVideoSecondNanoUsd && r.perVideoSecondNanoUsd !== "0" ? nanoToUsdText(BigInt(r.perVideoSecondNanoUsd)) : "",
      longContextThresholdTokens: r.longContextThresholdTokens ? String(r.longContextThresholdTokens) : "",
      longContextInputMultiplier: r.longContextInputMultiplier !== undefined ? String(r.longContextInputMultiplier) : "",
      longContextOutputMultiplier: r.longContextOutputMultiplier !== undefined ? String(r.longContextOutputMultiplier) : "",
      serviceTierFastMultiplier: r.serviceTierFastMultiplier !== undefined ? String(r.serviceTierFastMultiplier) : "",
      serviceTierFlexMultiplier: r.serviceTierFlexMultiplier !== undefined ? String(r.serviceTierFlexMultiplier) : "",
      enabled: r.enabled,
      notes: r.notes,
    });
  } else {
    showAdvanced.value = false;
    Object.assign(form, {
      pattern: props.preset?.pattern ?? "",
      input: props.preset?.input ?? "",
      output: props.preset?.output ?? "",
      cacheRead: "",
      cacheWrite: "",
      perRequest: "",
      perImage: "",
      perVideoSecond: "",
      longContextThresholdTokens: "",
      longContextInputMultiplier: "",
      longContextOutputMultiplier: "",
      serviceTierFastMultiplier: "",
      serviceTierFlexMultiplier: "",
      enabled: true,
      notes: "",
    });
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) init();
  },
  { immediate: true },
);

watch(
  () => form.pattern,
  () => (conflict.value = null),
);

/* ---------------- Pattern ---------------- */

const pattern = computed(() => form.pattern.trim());
const patternValid = computed(() => pattern.value.length > 0 && pattern.value.length <= PATTERN_MAX && PATTERN_RE.test(pattern.value));
const prefix = computed(() => isPrefixPattern(pattern.value));
const others = computed(() => props.rules.filter((r) => r.id !== props.rule?.id));
const duplicate = computed(() => others.value.some((r) => r.pattern === pattern.value));

const patternError = computed(() => {
  if (conflict.value) return conflict.value;
  if (!pattern.value) return submitted.value ? t("pricing.form.patternHint") : null;
  if (!patternValid.value) return t("pricing.form.patternInvalid");
  if (duplicate.value) return t("pricing.form.patternDuplicate");
  return null;
});

/** Exact pattern: the prefix rule it outranks for that model. */
const outranks = computed(() => {
  if (!patternValid.value || prefix.value) return null;
  return matchPricingRule(
    others.value.filter((r) => isPrefixPattern(r.pattern)),
    pattern.value,
  );
});

/** Prefix pattern: enabled rules inside it that are more specific and win over it. */
const shadowedCount = computed(() => {
  if (!patternValid.value || !prefix.value) return 0;
  const stem = patternStem(pattern.value);
  return others.value.filter((r) => {
    if (!r.enabled) return false;
    const s = patternStem(r.pattern);
    return s.startsWith(stem) && (isPrefixPattern(r.pattern) ? s.length > stem.length : true);
  }).length;
});

/* ---------------- Prices ---------------- */

const inputNano = computed(() => parsePriceInput(form.input));
const outputNano = computed(() => parsePriceInput(form.output));

function optionalPrice(text: string): { value: bigint | null; invalid: boolean } {
  if (!text.trim()) return { value: null, invalid: false };
  const v = parsePriceInput(text);
  return { value: v, invalid: v === null };
}

const cacheReadParsed = computed(() => optionalPrice(form.cacheRead));
const cacheWriteParsed = computed(() => optionalPrice(form.cacheWrite));

const invalid = computed(() => ({
  input: (submitted.value || form.input.trim() !== "") && inputNano.value === null,
  output: (submitted.value || form.output.trim() !== "") && outputNano.value === null,
  cacheRead: cacheReadParsed.value.invalid,
  cacheWrite: cacheWriteParsed.value.invalid,
}));
const anyPriceInvalid = computed(() => Object.values(invalid.value).some(Boolean));

function optionalMult(text: string): { value: number | undefined; invalid: boolean } {
  const tVal = text.trim();
  if (!tVal) return { value: undefined, invalid: false };
  const n = Number(tVal);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return { value: undefined, invalid: true };
  return { value: n, invalid: false };
}

function optionalThreshold(text: string): { value: number | undefined; invalid: boolean } {
  const tVal = text.trim();
  if (!tVal) return { value: undefined, invalid: false };
  const n = Number(tVal);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { value: undefined, invalid: true };
  return { value: n, invalid: false };
}

const advancedInvalid = computed(() => {
  const unitInvalid = [form.perRequest, form.perImage, form.perVideoSecond].some(
    (s) => s.trim() !== "" && normalizeUnitPriceInput(s) === null,
  );
  const multInvalid = [
    form.longContextInputMultiplier,
    form.longContextOutputMultiplier,
    form.serviceTierFastMultiplier,
    form.serviceTierFlexMultiplier,
  ].some((s) => optionalMult(s).invalid);
  return unitInvalid || multInvalid || optionalThreshold(form.longContextThresholdTokens).invalid;
});

const cachePlaceholder = computed(() => {
  const input = inputNano.value;
  if (input === null) return { read: "", write: "" };
  return {
    read: t("pricing.form.cachePlaceholder", { value: nanoToUsdText(defaultCacheRead(input)) }),
    write: t("pricing.form.cachePlaceholder", { value: nanoToUsdText(defaultCacheWrite(input)) }),
  };
});

const tier = computed(() => builtinTierFor(patternStem(pattern.value)));

function useBuiltin() {
  form.input = nanoToUsdText(tier.value.prices.input);
  form.output = nanoToUsdText(tier.value.prices.output);
  form.cacheRead = "";
  form.cacheWrite = "";
}

const priceFields = [
  { key: "input", required: true },
  { key: "output", required: true },
  { key: "cacheRead", required: false },
  { key: "cacheWrite", required: false },
] as const;

/* ---------------- Preview ---------------- */

const sortedGroups = computed(() =>
  [...props.groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
);
const sampleGroup = computed(() => props.groups.find((g) => g.id === sample.groupId) ?? null);
const multiplier = computed(() => sampleGroup.value?.rateMultiplier ?? 1);

const preview = computed(() => {
  const input = inputNano.value;
  const output = outputNano.value;
  if (input === null || output === null) return null;
  const inT = clampTokens(sample.inputTokens);
  const outT = clampTokens(sample.outputTokens);
  const prices = { input, output };
  const total = sampleCost(prices, inT, outT, multiplier.value);
  const builtin = sampleCost(tier.value.prices, inT, outT, multiplier.value);
  let delta: { tone: "success" | "warning" | "neutral"; text: string };
  if (builtin === 0n || total === builtin) {
    delta = { tone: "neutral", text: t("pricing.preview.same") };
  } else {
    const ratio = Number(total - builtin) / Number(builtin);
    const pct = `${Math.abs(ratio * 100).toFixed(Math.abs(ratio) < 0.1 ? 1 : 0)}%`;
    delta =
      ratio < 0
        ? { tone: "success", text: t("pricing.preview.cheaper", { pct }) }
        : { tone: "warning", text: t("pricing.preview.pricier", { pct }) };
  }
  return {
    inT,
    outT,
    input,
    output,
    inCost: partCost(input, inT),
    outCost: partCost(output, outT),
    subtotal: sampleCost(prices, inT, outT, 1),
    total,
    builtin,
    delta,
  };
});

const usd = (nano: bigint) => formatUsd(nano.toString());

/* ---------------- Submit ---------------- */

const canSubmit = computed(
  () =>
    patternValid.value &&
    !duplicate.value &&
    !conflict.value &&
    inputNano.value !== null &&
    outputNano.value !== null &&
    !anyPriceInvalid.value &&
    !advancedInvalid.value,
);

function close() {
  if (!saving.value) emit("update:open", false);
}

async function submit() {
  submitted.value = true;
  if (!canSubmit.value || saving.value) return;
  const readText = form.cacheRead.trim() ? normalizePriceInput(form.cacheRead) : null;
  const writeText = form.cacheWrite.trim() ? normalizePriceInput(form.cacheWrite) : null;
  const perReq = form.perRequest.trim() ? normalizeUnitPriceInput(form.perRequest) : null;
  const perImg = form.perImage.trim() ? normalizeUnitPriceInput(form.perImage) : null;
  const perVid = form.perVideoSecond.trim() ? normalizeUnitPriceInput(form.perVideoSecond) : null;
  const lcThresh = optionalThreshold(form.longContextThresholdTokens).value;
  const lcIn = optionalMult(form.longContextInputMultiplier).value;
  const lcOut = optionalMult(form.longContextOutputMultiplier).value;
  const stFast = optionalMult(form.serviceTierFastMultiplier).value;
  const stFlex = optionalMult(form.serviceTierFlexMultiplier).value;
  const body: UpsertModelPricingRule = {
    pattern: pattern.value,
    inputPerMTokUsd: normalizePriceInput(form.input)!,
    outputPerMTokUsd: normalizePriceInput(form.output)!,
    ...(readText ? { cacheReadPerMTokUsd: readText } : {}),
    ...(writeText ? { cacheWritePerMTokUsd: writeText } : {}),
    ...(perReq ? { perRequestUsd: perReq } : {}),
    ...(perImg ? { perImageUsd: perImg } : {}),
    ...(perVid ? { perVideoSecondUsd: perVid } : {}),
    ...(lcThresh !== undefined ? { longContextThresholdTokens: lcThresh } : {}),
    ...(lcIn !== undefined ? { longContextInputMultiplier: lcIn } : {}),
    ...(lcOut !== undefined ? { longContextOutputMultiplier: lcOut } : {}),
    ...(stFast !== undefined ? { serviceTierFastMultiplier: stFast } : {}),
    ...(stFlex !== undefined ? { serviceTierFlexMultiplier: stFlex } : {}),
    ...(props.rule?.reasoningEffortMultipliers ? { reasoningEffortMultipliers: props.rule.reasoningEffortMultipliers } : {}),
    enabled: form.enabled,
    notes: form.notes.trim(),
  };
  const editing = props.rule;
  saving.value = true;
  try {
    const { item } = await apiJson<{ item: ModelPricingRule }>(
      editing ? `/api/v1/admin/pricing/${encodeURIComponent(editing.id)}` : "/api/v1/admin/pricing",
      { method: editing ? "PUT" : "POST", body, fallbackError: t("pricing.errors.save") },
    );
    saving.value = false;
    emit("saved", item, !editing);
    emit("update:open", false);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) conflict.value = t("pricing.form.patternDuplicate");
    toast.error(errorText(err, t("pricing.errors.save")));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal
    :open="open"
    width="xl"
    :title="rule ? t('pricing.form.editTitle') : t('pricing.form.createTitle')"
    :persistent="saving"
    @update:open="(v) => (v ? emit('update:open', true) : close())"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="rule ? 'pencil' : 'sliders'" :size="15" />
      </span>
    </template>

    <form id="pricing-rule-form" class="grid gap-5 md:grid-cols-5" novalidate @submit.prevent="submit">
      <!-- Rule fields -->
      <div class="min-w-0 space-y-4 md:col-span-3">
        <FormField :label="t('pricing.form.pattern')" required>
          <input
            v-model="form.pattern"
            type="text"
            :maxlength="PATTERN_MAX"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            class="input font-mono"
            :class="patternError ? '!border-danger focus:!ring-danger/20' : ''"
            :placeholder="t('pricing.form.patternPlaceholder')"
            :aria-invalid="Boolean(patternError)"
            aria-describedby="pricing-pattern-help"
          />
        </FormField>
        <div id="pricing-pattern-help" class="-mt-2.5 min-h-[1.25rem] space-y-1 text-xs" aria-live="polite">
          <p v-if="patternError" class="flex items-start gap-1.5 text-danger">
            <UiIcon name="alert" :size="13" class="mt-px" />
            {{ patternError }}
          </p>
          <template v-else-if="patternValid">
            <p class="flex flex-wrap items-center gap-1.5 text-fg-muted">
              <UiBadge :tone="prefix ? 'info' : 'neutral'">{{ prefix ? t("pricing.kind.prefix") : t("pricing.kind.exact") }}</UiBadge>
              {{ prefix ? t("pricing.form.patternPrefix") : t("pricing.form.patternExact") }}
              <span class="code-chip max-w-full truncate">{{ prefix ? `${patternStem(pattern)}…` : pattern }}</span>
            </p>
            <p v-if="outranks" class="flex flex-wrap items-center gap-1.5 text-fg-subtle">
              <UiIcon name="arrow-up" :size="12" class="text-success" />
              {{ t("pricing.form.precedenceOver") }}
              <span class="code-chip">{{ outranks.pattern }}</span>
            </p>
            <p v-if="shadowedCount > 0" class="flex items-center gap-1.5 text-fg-subtle">
              <UiIcon name="layers" :size="12" class="text-info" />
              {{ t("pricing.form.shadowed", { n: shadowedCount }) }}
            </p>
          </template>
          <p v-else class="text-fg-subtle">{{ t("pricing.form.patternHint") }}</p>
        </div>

        <fieldset class="min-w-0 rounded-xl border border-line bg-surface-2/30 p-3.5 dark:bg-surface-2/20">
          <legend class="sr-only">{{ t("pricing.form.prices") }}</legend>
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-medium text-fg-muted" aria-hidden="true">{{ t("pricing.form.prices") }}</p>
            <button
              type="button"
              class="btn btn-ghost btn-xs -mr-1 text-accent hover:!text-accent"
              :title="t('pricing.form.useBuiltinHint', { tier: t(`pricing.builtin.tiers.${tier.key}`) })"
              @click="useBuiltin"
            >
              <UiIcon name="sparkles" :size="12" />
              {{ t("pricing.form.useBuiltin") }}
            </button>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <FormField
              v-for="f in priceFields"
              :key="f.key"
              :label="t(`pricing.form.${f.key}`)"
              :required="f.required"
            >
              <span class="relative block">
                <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-fg-subtle">$</span>
                <input
                  v-model="form[f.key]"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  class="input pl-7 pr-11 font-mono tabular-nums"
                  :class="invalid[f.key] ? '!border-danger focus:!ring-danger/20' : ''"
                  :placeholder="f.key === 'cacheRead' ? cachePlaceholder.read : f.key === 'cacheWrite' ? cachePlaceholder.write : '0'"
                  :aria-invalid="invalid[f.key]"
                />
                <span class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-2xs text-fg-subtle">/ 1M</span>
              </span>
            </FormField>
          </div>
          <p class="hint mt-2.5" :class="anyPriceInvalid ? '!text-danger' : ''">
            {{ anyPriceInvalid ? t("pricing.form.priceInvalid") : t("pricing.form.cacheHint") }}
          </p>
        </fieldset>

        <div class="rounded-xl border border-line bg-surface-2/25 p-3.5">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-xs font-medium text-fg-muted hover:text-fg"
            @click="showAdvanced = !showAdvanced"
          >
            <span class="flex items-center gap-1.5">
              <UiIcon name="sliders" :size="13" />
              {{ t("pricing.form.advancedTitle") }}
            </span>
            <UiIcon :name="showAdvanced ? 'chevron-down' : 'chevron-right'" :size="14" />
          </button>
          <div v-if="showAdvanced" class="mt-3 space-y-3 border-t border-line/60 pt-3">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField :label="t('pricing.form.perRequestUsd')">
                <input v-model="form.perRequest" type="text" inputmode="decimal" placeholder="0" class="input input-sm font-mono tabular-nums" />
              </FormField>
              <FormField :label="t('pricing.form.perImageUsd')">
                <input v-model="form.perImage" type="text" inputmode="decimal" placeholder="0.04" class="input input-sm font-mono tabular-nums" />
              </FormField>
              <FormField :label="t('pricing.form.perVideoSecondUsd')">
                <input v-model="form.perVideoSecond" type="text" inputmode="decimal" placeholder="0.10" class="input input-sm font-mono tabular-nums" />
              </FormField>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField :label="t('pricing.form.longContextThreshold')">
                <input v-model="form.longContextThresholdTokens" type="number" min="0" step="1000" placeholder="200000" class="input input-sm font-mono tabular-nums" />
              </FormField>
              <FormField :label="t('pricing.form.longContextInputMult')">
                <input v-model="form.longContextInputMultiplier" type="text" inputmode="decimal" placeholder="2" class="input input-sm font-mono tabular-nums" />
              </FormField>
              <FormField :label="t('pricing.form.longContextOutputMult')">
                <input v-model="form.longContextOutputMultiplier" type="text" inputmode="decimal" placeholder="1.5" class="input input-sm font-mono tabular-nums" />
              </FormField>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <FormField :label="t('pricing.form.serviceTierFastMult')">
                <input v-model="form.serviceTierFastMultiplier" type="text" inputmode="decimal" placeholder="2" class="input input-sm font-mono tabular-nums" />
              </FormField>
              <FormField :label="t('pricing.form.serviceTierFlexMult')">
                <input v-model="form.serviceTierFlexMultiplier" type="text" inputmode="decimal" placeholder="0.5" class="input input-sm font-mono tabular-nums" />
              </FormField>
            </div>
            <p v-if="advancedInvalid" class="text-2xs text-danger">{{ t("pricing.form.advancedInvalid") }}</p>
          </div>
        </div>

        <FormField :label="t('pricing.form.notes')">
          <input
            v-model="form.notes"
            type="text"
            maxlength="200"
            class="input"
            :placeholder="t('pricing.form.notesPlaceholder')"
          />
        </FormField>

        <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3">
          <p class="flex items-center gap-2 text-sm font-medium text-fg">
            <UiIcon name="check-circle" :size="14" class="text-success" />
            {{ t("pricing.form.enabled") }}
          </p>
          <UiSwitch v-model="form.enabled" :label="t('pricing.form.enabled')" hide-label />
        </div>
      </div>

      <!-- Live preview -->
      <aside class="min-w-0 md:col-span-2">
        <div class="rounded-xl border border-line bg-surface-2/40 p-4 md:sticky md:top-0 dark:bg-surface-2/25">
          <div class="flex items-start gap-2.5">
            <span class="icon-chip icon-chip-violet h-7 w-7"><UiIcon name="chart" :size="14" /></span>
            <div class="min-w-0">
              <p class="text-sm font-semibold text-fg">{{ t("pricing.preview.title") }}</p>
              <p class="text-2xs leading-relaxed text-fg-subtle">{{ t("pricing.preview.hint") }}</p>
            </div>
          </div>

          <div class="mt-3 grid grid-cols-2 gap-2">
            <label class="block min-w-0">
              <span class="mb-1 block text-2xs font-medium text-fg-subtle">{{ t("pricing.preview.inputTokens") }}</span>
              <input
                v-model.number="sample.inputTokens"
                type="number"
                min="0"
                :max="TOKENS_MAX"
                step="1000"
                class="input input-sm font-mono tabular-nums"
              />
            </label>
            <label class="block min-w-0">
              <span class="mb-1 block text-2xs font-medium text-fg-subtle">{{ t("pricing.preview.outputTokens") }}</span>
              <input
                v-model.number="sample.outputTokens"
                type="number"
                min="0"
                :max="TOKENS_MAX"
                step="100"
                class="input input-sm font-mono tabular-nums"
              />
            </label>
            <label v-if="groups.length" class="col-span-2 block min-w-0">
              <span class="mb-1 block text-2xs font-medium text-fg-subtle">{{ t("pricing.preview.group") }}</span>
              <UiSelect v-model="sample.groupId" class="select input-sm">
                <option value="">{{ t("pricing.preview.noGroup") }}</option>
                <option v-for="g in sortedGroups" :key="g.id" :value="g.id">
                  {{ g.name }} · {{ multiplierText(g.rateMultiplier) }}
                </option>
              </UiSelect>
            </label>
          </div>

          <div v-if="preview" class="mt-4">
            <dl class="space-y-1.5 text-xs">
              <div class="flex items-baseline justify-between gap-3">
                <dt class="min-w-0 truncate text-fg-subtle">
                  {{ t("pricing.preview.inputCost") }}
                  <span class="font-mono text-2xs">{{ formatNumber(preview.inT) }} × {{ formatPerM(preview.input) }}</span>
                </dt>
                <dd class="shrink-0 font-mono tabular-nums text-fg-muted">{{ usd(preview.inCost) }}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3">
                <dt class="min-w-0 truncate text-fg-subtle">
                  {{ t("pricing.preview.outputCost") }}
                  <span class="font-mono text-2xs">{{ formatNumber(preview.outT) }} × {{ formatPerM(preview.output) }}</span>
                </dt>
                <dd class="shrink-0 font-mono tabular-nums text-fg-muted">{{ usd(preview.outCost) }}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3 border-t border-dashed border-line-strong/70 pt-1.5">
                <dt class="text-fg-subtle">{{ t("pricing.preview.subtotal") }}</dt>
                <dd class="font-mono tabular-nums text-fg">{{ usd(preview.subtotal) }}</dd>
              </div>
              <div v-if="multiplier !== 1" class="flex items-baseline justify-between gap-3">
                <dt class="text-fg-subtle">{{ t("pricing.preview.multiplier") }}</dt>
                <dd class="font-mono tabular-nums text-violet">× {{ multiplierText(multiplier) }}</dd>
              </div>
            </dl>

            <div class="mt-3 rounded-lg bg-accent/[0.07] px-3 py-2.5 ring-1 ring-inset ring-accent/20">
              <p class="text-2xs font-medium text-fg-subtle">{{ t("pricing.preview.total") }}</p>
              <Transition
                mode="out-in"
                enter-active-class="transition duration-150 ease-out"
                enter-from-class="translate-y-0.5 opacity-0"
                leave-active-class="transition duration-75 ease-in"
                leave-to-class="opacity-0"
              >
                <p :key="preview.total.toString()" class="mt-0.5 truncate font-mono text-xl font-semibold tabular-nums text-accent">
                  {{ usd(preview.total) }}
                </p>
              </Transition>
            </div>

            <div class="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-2xs">
              <span class="text-fg-subtle">
                {{ t("pricing.preview.builtin") }}
                <span class="font-mono tabular-nums text-fg-muted">{{ usd(preview.builtin) }}</span>
              </span>
              <UiBadge :tone="preview.delta.tone">{{ preview.delta.text }}</UiBadge>
            </div>
          </div>
          <p
            v-else
            class="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-line-strong/70 px-3 py-4 text-xs text-fg-subtle"
          >
            <UiIcon name="info" :size="13" />
            {{ t("pricing.preview.incomplete") }}
          </p>
        </div>
      </aside>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="close">{{ t("common.cancel") }}</button>
      <button type="submit" form="pricing-rule-form" class="btn btn-primary" :disabled="saving || (submitted && !canSubmit)">
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ rule ? t("pricing.form.submitSave") : t("pricing.form.submitCreate") }}
      </button>
    </template>
  </UiModal>
</template>
