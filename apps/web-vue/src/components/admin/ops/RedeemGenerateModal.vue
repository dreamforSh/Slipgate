<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { GenerateRedeemCodesRequest, GroupItem, RedeemCodeItem, RedeemCodeKind } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import ExpiryPresetField from "./ExpiryPresetField.vue";
import { normalizeUsdInput, resolveExpiry, type ExpiryPreset } from "./opsUtil";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "generated", items: RedeemCodeItem[]): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const groups = ref<GroupItem[]>([]);
const groupsLoading = ref(false);
const groupsLoaded = ref(false);
const submitting = ref(false);
const attempted = ref(false);

interface GenerateForm {
  kind: RedeemCodeKind;
  amountUsd: string;
  groupId: string;
  validityDays: number;
  count: number;
  maxUses: number;
  perUserLimit: number;
  batchPerUserLimit: number;
  prefix: string;
  expiryPreset: ExpiryPreset;
  expiryCustom: string;
  notes: string;
}

function blank(): GenerateForm {
  return {
    kind: "balance",
    amountUsd: "",
    groupId: "",
    validityDays: 30,
    count: 10,
    maxUses: 1,
    perUserLimit: 1,
    batchPerUserLimit: 0,
    prefix: "",
    expiryPreset: "never",
    expiryCustom: "",
    notes: "",
  };
}

const form = reactive<GenerateForm>(blank());

const kindIcon: Record<RedeemCodeKind, IconName> = { balance: "wallet", subscription: "crown", invitation: "user-plus" };
const kindOptions = computed(() =>
  (["balance", "subscription", "invitation"] as const).map((value) => ({ value, label: t(`redeem.kinds.${value}`) })),
);

const subscriptionGroups = computed(() =>
  groups.value
    .filter((g) => g.subscriptionType === "subscription")
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
);

async function loadGroups() {
  if (groupsLoaded.value || groupsLoading.value) return;
  groupsLoading.value = true;
  try {
    groups.value = (await apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups")).groups;
    groupsLoaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("redeem.admin.errors.groups")));
  } finally {
    groupsLoading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    Object.assign(form, blank());
    attempted.value = false;
  },
  { immediate: true },
);

watch(
  () => form.kind,
  (kind) => {
    if (kind === "subscription") void loadGroups();
  },
);

watch(
  () => form.groupId,
  (id) => {
    const g = groups.value.find((x) => x.id === id);
    if (g) form.validityDays = g.defaultValidityDays;
  },
);

function onPrefix(ev: Event) {
  const el = ev.target as HTMLInputElement;
  form.prefix = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  el.value = form.prefix;
}

/* ---------------- Validation ---------------- */

const errors = computed(() => {
  const e: Partial<
    Record<"amount" | "group" | "days" | "count" | "maxUses" | "perUserLimit" | "batchPerUserLimit" | "prefix" | "expiry", string>
  > = {};
  if (form.kind === "balance" && !normalizeUsdInput(form.amountUsd)) e.amount = t("redeem.admin.generate.errors.amount");
  if (form.kind === "subscription") {
    if (!form.groupId) e.group = t("redeem.admin.generate.errors.group");
    if (!Number.isInteger(form.validityDays) || form.validityDays < 1 || form.validityDays > 3650) {
      e.days = t("redeem.admin.generate.errors.days");
    }
  }
  if (!Number.isInteger(form.count) || form.count < 1 || form.count > 500) e.count = t("redeem.admin.generate.errors.count");
  if (!Number.isInteger(form.maxUses) || form.maxUses < 1 || form.maxUses > 100_000) {
    e.maxUses = t("redeem.admin.generate.errors.maxUses");
  }
  if (!Number.isInteger(form.perUserLimit) || form.perUserLimit < 1 || form.perUserLimit > 1000) {
    e.perUserLimit = t("redeem.admin.generate.errors.perUserLimit");
  }
  if (!Number.isInteger(form.batchPerUserLimit) || form.batchPerUserLimit < 0 || form.batchPerUserLimit > 1000) {
    e.batchPerUserLimit = t("redeem.admin.generate.errors.batchPerUserLimit");
  }
  if (!/^[A-Z0-9]{0,8}$/.test(form.prefix)) e.prefix = t("redeem.admin.generate.errors.prefix");
  if (form.expiryPreset === "custom" && resolveExpiry("custom", form.expiryCustom) === undefined) {
    e.expiry = t("redeem.admin.generate.errors.expiry");
  }
  return e;
});

const shown = computed(() => (attempted.value ? errors.value : {}));
const countLabel = computed(() => (Number.isInteger(form.count) && form.count > 0 ? form.count : 0));

async function submit() {
  attempted.value = true;
  if (Object.keys(errors.value).length > 0) return;
  const expiresAtIso = resolveExpiry(form.expiryPreset, form.expiryCustom);
  if (expiresAtIso === undefined) return;
  const body: GenerateRedeemCodesRequest = {
    kind: form.kind,
    count: form.count,
    maxUses: form.maxUses,
    perUserLimit: form.perUserLimit,
    batchPerUserLimit: form.batchPerUserLimit,
    prefix: form.prefix,
    notes: form.notes.trim(),
    expiresAtIso,
    ...(form.kind === "balance" ? { amountUsd: normalizeUsdInput(form.amountUsd) ?? "" } : {}),
    ...(form.kind === "subscription" ? { groupId: form.groupId, validityDays: form.validityDays } : {}),
  };
  submitting.value = true;
  try {
    const res = await apiJson<{ items: RedeemCodeItem[] }>("/api/v1/admin/redeem-codes/generate", {
      method: "POST",
      body,
      fallbackError: t("redeem.admin.errors.generate"),
    });
    emit("generated", res.items);
    emit("update:open", false);
  } catch (err) {
    toast.error(errorText(err, t("redeem.admin.errors.generate")));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <UiModal
    :open="open"
    width="lg"
    :title="t('redeem.admin.generate.title')"
    :persistent="submitting"
    @update:open="emit('update:open', $event)"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon name="ticket" :size="15" />
      </span>
    </template>

    <form id="redeem-generate-form" class="grid gap-4 sm:grid-cols-2" novalidate @submit.prevent="submit">
      <div class="sm:col-span-2">
        <p class="label">{{ t("redeem.admin.generate.kind") }}</p>
        <SegmentedControl v-model="form.kind" :options="kindOptions" size="md" block />
        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="translate-y-1 opacity-0"
          leave-active-class="transition duration-100 ease-in"
          leave-to-class="opacity-0"
        >
          <p :key="form.kind" class="mt-2 flex items-start gap-2 text-xs text-fg-muted">
            <UiIcon :name="kindIcon[form.kind]" :size="14" class="mt-px shrink-0 text-accent" />
            {{ t(`redeem.admin.generate.kindHints.${form.kind}`) }}
          </p>
        </Transition>
      </div>

      <!-- Balance -->
      <FormField v-if="form.kind === 'balance'" :label="t('redeem.admin.generate.amount')" required class="sm:col-span-2">
        <span class="relative block">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">$</span>
          <input
            v-model="form.amountUsd"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            class="input pl-7 font-mono"
            :class="shown.amount ? '!border-danger' : ''"
            :placeholder="t('redeem.admin.generate.amountPlaceholder')"
          />
        </span>
        <p v-if="shown.amount" class="mt-1 text-xs text-danger">{{ shown.amount }}</p>
      </FormField>

      <!-- Subscription -->
      <template v-if="form.kind === 'subscription'">
        <div class="sm:col-span-2">
          <UiAlert v-if="groupsLoaded && subscriptionGroups.length === 0" tone="warning">
            {{ t("redeem.admin.generate.noGroups") }}
            <template #action>
              <RouterLink to="/admin/groups" class="btn btn-secondary btn-xs self-center">
                {{ t("redeem.admin.generate.goGroups") }}
              </RouterLink>
            </template>
          </UiAlert>
        </div>
        <FormField :label="t('redeem.admin.generate.group')" required>
          <span class="relative block">
            <select
              v-model="form.groupId"
              class="select"
              :class="shown.group ? '!border-danger' : ''"
              :disabled="groupsLoading || subscriptionGroups.length === 0"
            >
              <option value="" disabled>{{ t("redeem.admin.generate.groupPlaceholder") }}</option>
              <option v-for="g in subscriptionGroups" :key="g.id" :value="g.id">
                {{ g.name }}{{ g.enabled ? "" : ` (${t("common.disabled")})` }}
              </option>
            </select>
            <UiIcon
              v-if="groupsLoading"
              name="loader"
              :size="14"
              spin
              class="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
          </span>
          <p v-if="shown.group" class="mt-1 text-xs text-danger">{{ shown.group }}</p>
        </FormField>
        <FormField :label="t('redeem.admin.generate.validityDays')" required>
          <input
            v-model.number="form.validityDays"
            type="number"
            min="1"
            max="3650"
            step="1"
            class="input font-mono"
            :class="shown.days ? '!border-danger' : ''"
          />
          <p v-if="shown.days" class="mt-1 text-xs text-danger">{{ shown.days }}</p>
        </FormField>
      </template>

      <FormField :label="t('redeem.admin.generate.count')" required>
        <input
          v-model.number="form.count"
          type="number"
          min="1"
          max="500"
          step="1"
          class="input font-mono"
          :class="shown.count ? '!border-danger' : ''"
        />
        <p class="mt-1 text-xs" :class="shown.count ? 'text-danger' : 'text-fg-subtle'">
          {{ shown.count ?? t("redeem.admin.generate.countHint") }}
        </p>
      </FormField>
      <FormField :label="t('redeem.admin.generate.prefix')">
        <input
          :value="form.prefix"
          type="text"
          maxlength="8"
          autocomplete="off"
          spellcheck="false"
          class="input font-mono uppercase tracking-wider"
          :class="shown.prefix ? '!border-danger' : ''"
          :placeholder="t('redeem.admin.generate.prefixPlaceholder')"
          @input="onPrefix"
        />
        <p class="mt-1 text-xs" :class="shown.prefix ? 'text-danger' : 'text-fg-subtle'">
          {{ shown.prefix ?? t("redeem.admin.generate.prefixHint") }}
        </p>
      </FormField>

      <div class="grid gap-3 sm:col-span-2 sm:grid-cols-3">
        <FormField :label="t('redeem.admin.generate.maxUses')">
          <input
            v-model.number="form.maxUses"
            type="number"
            min="1"
            max="100000"
            step="1"
            class="input font-mono"
            :class="shown.maxUses ? '!border-danger' : ''"
          />
          <p class="mt-1 text-2xs" :class="shown.maxUses ? 'text-danger' : 'text-fg-subtle'">
            {{ shown.maxUses ?? t("redeem.admin.generate.maxUsesHint") }}
          </p>
        </FormField>
        <FormField :label="t('redeem.admin.generate.perUserLimit')">
          <input
            v-model.number="form.perUserLimit"
            type="number"
            min="1"
            max="1000"
            step="1"
            class="input font-mono"
            :class="shown.perUserLimit ? '!border-danger' : ''"
          />
          <p class="mt-1 text-2xs" :class="shown.perUserLimit ? 'text-danger' : 'text-fg-subtle'">
            {{ shown.perUserLimit ?? t("redeem.admin.generate.perUserLimitHint") }}
          </p>
        </FormField>
        <FormField :label="t('redeem.admin.generate.batchPerUserLimit')">
          <input
            v-model.number="form.batchPerUserLimit"
            type="number"
            min="0"
            max="1000"
            step="1"
            class="input font-mono"
            :class="shown.batchPerUserLimit ? '!border-danger' : ''"
          />
          <p class="mt-1 text-2xs" :class="shown.batchPerUserLimit ? 'text-danger' : 'text-fg-subtle'">
            {{ shown.batchPerUserLimit ?? t("redeem.admin.generate.batchPerUserLimitHint") }}
          </p>
        </FormField>
      </div>

      <div class="sm:col-span-2">
        <ExpiryPresetField
          v-model:preset="form.expiryPreset"
          v-model:custom="form.expiryCustom"
          :label="t('redeem.admin.generate.expiry')"
          :invalid="Boolean(shown.expiry)"
        />
        <p v-if="shown.expiry" class="mt-1 text-xs text-danger">{{ shown.expiry }}</p>
      </div>

      <FormField :label="t('redeem.admin.generate.notes')" class="sm:col-span-2">
        <input
          v-model="form.notes"
          type="text"
          maxlength="200"
          class="input"
          :placeholder="t('redeem.admin.generate.notesPlaceholder')"
        />
      </FormField>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="submitting" @click="emit('update:open', false)">
        {{ t("common.cancel") }}
      </button>
      <button type="submit" form="redeem-generate-form" class="btn btn-primary" :disabled="submitting">
        <UiIcon :name="submitting ? 'loader' : 'sparkles'" :size="15" :spin="submitting" />
        {{ submitting ? t("redeem.admin.generate.generating") : t("redeem.admin.generate.submit", { n: countLabel }) }}
      </button>
    </template>
  </UiModal>
</template>
