<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import {
  minorToFiat,
  type GroupItem,
  type PaymentCurrency,
  type PaymentPlan,
  type PaymentPlanKind,
  type UpsertPaymentPlanRequest,
} from "@slipgate/contracts";
import { apiJson, errorText } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";
import { nanoToUsdInput, normalizeUsdInput, parseUsdToNano } from "../admin/users/money";
import FormField from "../ui/FormField.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import PlanCard, { type PlanCardPlan } from "./PlanCard.vue";
import { creditNanoForMinor, currencySymbol, parseFiatInput, planBonusPct } from "./paymentUtil";
import UiSelect from "../ui/UiSelect.vue";

/** Create / edit a purchasable plan. PUT and POST both send the full body. */
const props = defineProps<{
  open: boolean;
  plan: PaymentPlan | null;
  /** Subscription-billed groups only. */
  groups: GroupItem[];
  defaultCurrency: PaymentCurrency;
  /** Configured rate for `defaultCurrency`; null when unknown. */
  minorPerUsd: number | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "saved", plan: PaymentPlan, created: boolean): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

interface PlanForm {
  name: string;
  description: string;
  kind: PaymentPlanKind;
  price: string;
  currency: PaymentCurrency;
  creditUsd: string;
  groupId: string;
  validityDays: number | null;
  badge: string;
  sortOrder: number;
  enabled: boolean;
}

const form = reactive<PlanForm>(blank());
const submitted = ref(false);
const saving = ref(false);

function blank(): PlanForm {
  return {
    name: "",
    description: "",
    kind: "recharge",
    price: "",
    currency: props.defaultCurrency,
    creditUsd: "",
    groupId: "",
    validityDays: 30,
    badge: "",
    sortOrder: 0,
    enabled: true,
  };
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    submitted.value = false;
    const p = props.plan;
    if (!p) {
      Object.assign(form, blank());
      return;
    }
    Object.assign(form, {
      name: p.name,
      description: p.description,
      kind: p.kind,
      price: minorToFiat(p.priceMinor),
      currency: p.currency,
      creditUsd: p.kind === "recharge" ? nanoToUsdInput(p.creditNanoUsd) : "",
      groupId: p.groupId ?? "",
      validityDays: p.validityDays ?? 30,
      badge: p.badge,
      sortOrder: p.sortOrder,
      enabled: p.enabled,
    } satisfies PlanForm);
  },
  { immediate: true },
);

const kindOptions = computed<{ value: PaymentPlanKind; label: string }[]>(() => [
  { value: "recharge", label: t("payments.kinds.recharge") },
  { value: "subscription", label: t("payments.kinds.subscription") },
]);

/** Keep a plan's current group selectable even if it is no longer subscription-billed. */
const groupOptions = computed(() => {
  const list = props.groups.map((g) => ({ id: g.id, name: g.enabled ? g.name : `${g.name} (${t("common.disabled")})` }));
  const p = props.plan;
  if (p?.groupId && !list.some((g) => g.id === p.groupId)) list.unshift({ id: p.groupId, name: p.groupName ?? p.groupId });
  return list;
});

const VALIDITY_PRESETS = [7, 30, 90, 180, 365];

/* ---------------- Validation ---------------- */

const priceMinor = computed(() => parseFiatInput(form.price));
const creditNano = computed(() => parseUsdToNano(form.creditUsd));

const errors = computed(() => {
  const e: Partial<Record<"name" | "price" | "credit" | "group" | "validity", string>> = {};
  if (!form.name.trim()) e.name = t("payments.admin.plans.editor.errors.name");
  if (priceMinor.value === null || priceMinor.value <= 0) e.price = t("payments.admin.plans.editor.errors.price");
  if (form.kind === "recharge" && (creditNano.value === null || creditNano.value <= 0n)) {
    e.credit = t("payments.admin.plans.editor.errors.credit");
  }
  if (form.kind === "subscription") {
    if (!form.groupId) e.group = t("payments.admin.plans.editor.errors.group");
    const d = form.validityDays;
    if (d === null || !Number.isInteger(d) || d < 1 || d > 3650) e.validity = t("payments.admin.plans.editor.errors.validity");
  }
  return e;
});
const invalid = computed(() => Object.keys(errors.value).length > 0);
const shown = (key: keyof typeof errors.value) => (submitted.value ? errors.value[key] : undefined);

/* ---------------- Rate helper ---------------- */

const baseNano = computed(() => {
  if (props.minorPerUsd === null || form.currency !== props.defaultCurrency || priceMinor.value === null) return null;
  const nano = creditNanoForMinor(priceMinor.value, props.minorPerUsd);
  return nano === "0" ? null : nano;
});

function useBase() {
  if (baseNano.value) form.creditUsd = nanoToUsdInput(baseNano.value);
}

/* ---------------- Preview ---------------- */

const preview = computed<PlanCardPlan>(() => ({
  name: form.name.trim(),
  description: form.description.trim(),
  kind: form.kind,
  priceMinor: priceMinor.value ?? 0,
  currency: form.currency,
  creditNanoUsd: creditNano.value !== null && creditNano.value > 0n ? creditNano.value.toString() : "0",
  groupName: groupOptions.value.find((g) => g.id === form.groupId)?.name ?? null,
  validityDays: form.validityDays,
  badge: form.badge.trim(),
}));

const previewBonus = computed(() =>
  props.minorPerUsd === null ? null : planBonusPct(preview.value, props.minorPerUsd, props.defaultCurrency),
);

/* ---------------- Save ---------------- */

function close() {
  if (!saving.value) emit("update:open", false);
}

async function submit() {
  submitted.value = true;
  if (invalid.value || saving.value) return;
  const body: UpsertPaymentPlanRequest = {
    name: form.name.trim(),
    description: form.description.trim(),
    kind: form.kind,
    price: minorToFiat(priceMinor.value ?? 0),
    currency: form.currency,
    badge: form.badge.trim(),
    enabled: form.enabled,
    sortOrder: Math.trunc(Number(form.sortOrder) || 0),
  };
  if (form.kind === "recharge") body.creditUsd = normalizeUsdInput(form.creditUsd) ?? undefined;
  else {
    body.groupId = form.groupId;
    body.validityDays = form.validityDays ?? 30;
  }
  saving.value = true;
  try {
    const editing = props.plan;
    const res = await apiJson<{ item: PaymentPlan }>(
      editing ? `/api/v1/admin/payments/plans/${encodeURIComponent(editing.id)}` : "/api/v1/admin/payments/plans",
      { method: editing ? "PUT" : "POST", body, fallbackError: t("payments.admin.plans.editor.errors.save") },
    );
    toast.success(editing ? t("payments.admin.plans.editor.saved") : t("payments.admin.plans.editor.created"));
    emit("saved", res.item, !editing);
    emit("update:open", false);
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.plans.editor.errors.save")));
  } finally {
    saving.value = false;
  }
}

const inputError = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <UiModal
    :open="open"
    width="xl"
    :title="plan ? t('payments.admin.plans.editor.editTitle') : t('payments.admin.plans.editor.createTitle')"
    :persistent="saving"
    @update:open="(v) => (v ? emit('update:open', true) : close())"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="plan ? 'pencil' : 'plus'" :size="15" />
      </span>
    </template>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <form id="payment-plan-form" class="min-w-0 space-y-4" novalidate @submit.prevent="submit">
        <div>
          <span class="label">{{ t("payments.admin.plans.editor.kind") }}</span>
          <SegmentedControl v-model="form.kind" :options="kindOptions" size="md" block />
        </div>

        <FormField :label="t('payments.admin.plans.editor.name')" required>
          <input
            v-model="form.name"
            type="text"
            maxlength="64"
            class="input"
            :class="shown('name') ? inputError : ''"
            :placeholder="t('payments.admin.plans.editor.namePlaceholder')"
          />
          <p v-if="shown('name')" class="mt-1 text-xs text-danger">{{ shown("name") }}</p>
        </FormField>

        <FormField :label="t('payments.admin.plans.editor.description')">
          <textarea
            v-model="form.description"
            rows="2"
            maxlength="500"
            class="textarea"
            :placeholder="t('payments.admin.plans.editor.descriptionPlaceholder')"
          />
        </FormField>

        <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <FormField :label="t('payments.admin.plans.editor.price')" required>
            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-fg-subtle">
                {{ currencySymbol(form.currency) }}
              </span>
              <input
                v-model="form.price"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                class="input pl-7 tabular-nums"
                :class="shown('price') ? inputError : ''"
                placeholder="0.00"
              />
            </div>
            <p v-if="shown('price')" class="mt-1 text-xs text-danger">{{ shown("price") }}</p>
          </FormField>
          <FormField :label="t('payments.admin.plans.editor.currency')">
            <UiSelect v-model="form.currency" class="select">
              <option value="CNY">{{ t("payments.currencies.CNY") }}</option>
              <option value="USD">{{ t("payments.currencies.USD") }}</option>
            </UiSelect>
          </FormField>
        </div>

        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0"
          leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
          leave-to-class="opacity-0"
        >
          <!-- Recharge: credit -->
          <div v-if="form.kind === 'recharge'" key="recharge">
            <FormField :label="t('payments.admin.plans.editor.creditUsd')" required>
              <div class="flex gap-2">
                <div class="relative min-w-0 flex-1">
                  <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-fg-subtle">$</span>
                  <input
                    v-model="form.creditUsd"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="input pl-7 tabular-nums"
                    :class="shown('credit') ? inputError : ''"
                    placeholder="0.00"
                  />
                </div>
                <button v-if="baseNano" type="button" class="btn btn-secondary shrink-0" @click="useBase">
                  <UiIcon name="zap" :size="14" />
                  {{ t("payments.admin.plans.editor.useBase") }}
                </button>
              </div>
              <p v-if="shown('credit')" class="mt-1 text-xs text-danger">{{ shown("credit") }}</p>
              <p v-else-if="baseNano" class="hint tabular-nums">
                {{ t("payments.admin.plans.editor.creditBase", { base: formatUsd(baseNano) }) }}
              </p>
            </FormField>
          </div>

          <!-- Subscription: group + validity -->
          <div v-else key="subscription" class="space-y-4">
            <UiAlert v-if="groupOptions.length === 0" tone="warning">
              {{ t("payments.admin.plans.editor.noGroups") }}
              <template #action>
                <RouterLink to="/admin/groups" class="btn btn-secondary btn-sm shrink-0">
                  {{ t("payments.admin.plans.editor.manageGroups") }}
                </RouterLink>
              </template>
            </UiAlert>
            <div class="grid gap-4 sm:grid-cols-2">
              <FormField :label="t('payments.admin.plans.editor.group')" required>
                <UiSelect v-model="form.groupId" class="select" :class="shown('group') ? inputError : ''" :disabled="groupOptions.length === 0">
                  <option value="" disabled>{{ t("payments.admin.plans.editor.groupPlaceholder") }}</option>
                  <option v-for="g in groupOptions" :key="g.id" :value="g.id">{{ g.name }}</option>
                </UiSelect>
                <p v-if="shown('group')" class="mt-1 text-xs text-danger">{{ shown("group") }}</p>
              </FormField>
              <FormField :label="t('payments.admin.plans.editor.validity')" required>
                <input
                  v-model.number="form.validityDays"
                  type="number"
                  min="1"
                  max="3650"
                  step="1"
                  class="input tabular-nums"
                  :class="shown('validity') ? inputError : ''"
                />
                <p v-if="shown('validity')" class="mt-1 text-xs text-danger">{{ shown("validity") }}</p>
              </FormField>
            </div>
            <div class="-mt-1 flex flex-wrap gap-1.5">
              <button
                v-for="d in VALIDITY_PRESETS"
                :key="d"
                type="button"
                class="btn btn-xs tabular-nums"
                :class="form.validityDays === d ? 'btn-primary' : 'btn-secondary'"
                @click="form.validityDays = d"
              >
                {{ t("payments.days", { n: d }) }}
              </button>
            </div>
          </div>
        </Transition>

        <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <FormField :label="t('payments.admin.plans.editor.badge')">
            <input
              v-model="form.badge"
              type="text"
              maxlength="24"
              class="input"
              :placeholder="t('payments.admin.plans.editor.badgePlaceholder')"
            />
            <p class="hint">{{ t("payments.admin.plans.editor.badgeHint") }}</p>
          </FormField>
          <FormField :label="t('payments.admin.plans.editor.sortOrder')">
            <input v-model.number="form.sortOrder" type="number" step="1" class="input tabular-nums" />
            <p class="hint">{{ t("payments.admin.plans.editor.sortHint") }}</p>
          </FormField>
        </div>

        <div class="flex items-center justify-between gap-4 rounded-xl border border-line px-3.5 py-3">
          <span class="text-sm font-medium text-fg">{{ t("payments.admin.plans.editor.enabled") }}</span>
          <UiSwitch v-model="form.enabled" :label="t('payments.admin.plans.editor.enabled')" hide-label />
        </div>
      </form>

      <!-- Live preview -->
      <aside class="hidden min-w-0 lg:block">
        <p class="eyebrow mb-4">{{ t("payments.admin.plans.editor.preview") }}</p>
        <div class="rounded-2xl bg-surface-2/50 p-4 pt-6 ring-1 ring-inset ring-line">
          <PlanCard
            :plan="preview"
            :interactive="false"
            :bonus-pct="previewBonus"
            :placeholder-name="t('payments.admin.plans.editor.previewName')"
          />
        </div>
      </aside>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="close">{{ t("common.cancel") }}</button>
      <button type="submit" form="payment-plan-form" class="btn btn-primary" :disabled="saving || (submitted && invalid)">
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ t("common.save") }}
      </button>
    </template>
  </UiModal>
</template>
