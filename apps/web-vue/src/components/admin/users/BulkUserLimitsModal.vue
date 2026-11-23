<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  USER_BATCH_MAX,
  USER_LIMIT_MAX,
  type AdminBatchUserConcurrencyRequest,
  type AdminBatchUserLimitsRequest,
  type AdminBatchUserLimitsResponse,
  type UserCap,
} from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { loadPortalCapDefaults, useLimitText, type PortalCapDefaults } from "./limits";

/**
 * Bulk RPM / concurrency caps for the selected users or everyone (Linksyncx BulkEditUserModal).
 * RPM: set a number, back to the portal default, or no cap. Concurrency also supports "add",
 * which shifts each user's effective cap (floored at 0) through batch-concurrency.
 */
const props = defineProps<{ userIds: string[]; totalUsers: number }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "done", updated: number): void }>();

const { t, capText, errorOf } = useLimitText();
const toast = useToastStore();

type Scope = "selected" | "all";
type RpmMode = "set" | "inherit" | "unlimited";
type ConcMode = "set" | "add" | "inherit" | "unlimited";

const scope = ref<Scope>("selected");
const rpmOn = ref(false);
const rpmMode = ref<RpmMode>("set");
// type="number" inputs hand back numbers once a value parses (Vue casts them).
const rpmText = ref<string | number>("");
const concOn = ref(false);
const concMode = ref<ConcMode>("set");
const concText = ref<string | number>("");
const confirming = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const defaults = ref<PortalCapDefaults | null>(null);

watch(open, async (isOpen) => {
  if (!isOpen) return;
  scope.value = props.userIds.length > 0 ? "selected" : "all";
  rpmOn.value = false;
  rpmMode.value = "set";
  rpmText.value = "";
  concOn.value = false;
  concMode.value = "set";
  concText.value = "";
  confirming.value = false;
  error.value = null;
  defaults.value = await loadPortalCapDefaults();
});

// Any edit after "review" asks for a fresh confirmation.
watch([scope, rpmOn, rpmMode, rpmText, concOn, concMode, concText], () => (confirming.value = false));

const scopeOptions = computed<{ value: Scope; label: string }[]>(() => [
  { value: "selected", label: t("userLimits.bulk.scopeSelected", { n: props.userIds.length }) },
  { value: "all", label: t("userLimits.bulk.scopeAll", { n: props.totalUsers }) },
]);
const rpmOptions = computed<{ value: RpmMode; label: string }[]>(() => [
  { value: "set", label: t("userLimits.bulk.modes.set") },
  { value: "inherit", label: t("userLimits.bulk.modes.inherit") },
  { value: "unlimited", label: t("userLimits.bulk.modes.unlimited") },
]);
const concOptions = computed<{ value: ConcMode; label: string }[]>(() => [
  { value: "set", label: t("userLimits.bulk.modes.set") },
  { value: "add", label: t("userLimits.bulk.modes.add") },
  { value: "inherit", label: t("userLimits.bulk.modes.inherit") },
  { value: "unlimited", label: t("userLimits.bulk.modes.unlimited") },
]);

function intText(text: string | number, min: number): number | null {
  const raw = String(text).trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= USER_LIMIT_MAX ? n : null;
}

/** The cap each section writes, or undefined when it is off; null value = invalid input. */
const rpmValue = computed<{ cap: UserCap } | null | undefined>(() => {
  if (!rpmOn.value) return undefined;
  if (rpmMode.value === "inherit") return { cap: null };
  if (rpmMode.value === "unlimited") return { cap: 0 };
  const n = intText(rpmText.value, 1);
  return n === null ? null : { cap: n };
});
const concValue = computed<{ cap: UserCap } | { add: number } | null | undefined>(() => {
  if (!concOn.value) return undefined;
  if (concMode.value === "inherit") return { cap: null };
  if (concMode.value === "unlimited") return { cap: 0 };
  if (concMode.value === "add") {
    const n = intText(concText.value, -USER_LIMIT_MAX);
    return n === null || n === 0 ? null : { add: n };
  }
  const n = intText(concText.value, 1);
  return n === null ? null : { cap: n };
});

const rpmInvalid = computed(() => rpmOn.value && rpmValue.value === null && String(rpmText.value).trim() !== "");
const concInvalid = computed(() => concOn.value && concValue.value === null && String(concText.value).trim() !== "");
const tooMany = computed(() => scope.value === "selected" && props.userIds.length > USER_BATCH_MAX);
const targetCount = computed(() => (scope.value === "all" ? props.totalUsers : props.userIds.length));
const ready = computed(
  () =>
    !busy.value &&
    !tooMany.value &&
    targetCount.value > 0 &&
    (rpmValue.value !== undefined || concValue.value !== undefined) &&
    rpmValue.value !== null &&
    concValue.value !== null,
);

/** Human summary of what will change, shown before the second click. */
const summary = computed(() => {
  const parts: string[] = [];
  const r = rpmValue.value;
  if (r) {
    parts.push(
      r.cap === null
        ? t("userLimits.bulk.summary.rpmInherit")
        : t("userLimits.bulk.summary.rpm", { value: capText(r.cap, "rpm") }),
    );
  }
  const c = concValue.value;
  if (c) {
    if ("add" in c) parts.push(t("userLimits.bulk.summary.concAdd", { n: c.add > 0 ? `+${c.add}` : `−${Math.abs(c.add)}` }));
    else if (c.cap === null) parts.push(t("userLimits.bulk.summary.concInherit"));
    else parts.push(t("userLimits.bulk.summary.conc", { value: capText(c.cap, "concurrency") }));
  }
  return parts.join(t("userLimits.bulk.summary.sep"));
});

async function submit() {
  if (!ready.value) return;
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  busy.value = true;
  error.value = null;
  const target = scope.value === "all" ? { all: true, userIds: [] } : { all: false, userIds: [...props.userIds] };
  try {
    let updated = 0;
    const limits: AdminBatchUserLimitsRequest = { ...target };
    const r = rpmValue.value;
    const c = concValue.value;
    if (r) limits.rpmLimit = r.cap;
    if (c && "cap" in c) limits.concurrencyLimit = c.cap;
    if (limits.rpmLimit !== undefined || limits.concurrencyLimit !== undefined) {
      const res = await apiJson<AdminBatchUserLimitsResponse>("/api/v1/admin/users/batch-limits", {
        method: "POST",
        body: limits,
      });
      updated = Math.max(updated, res.updated);
    }
    if (c && "add" in c) {
      const body: AdminBatchUserConcurrencyRequest = { ...target, mode: "add", value: c.add };
      const res = await apiJson<AdminBatchUserLimitsResponse>("/api/v1/admin/users/batch-concurrency", {
        method: "POST",
        body,
      });
      updated = Math.max(updated, res.updated);
    }
    toast.success(t("userLimits.bulk.done", { n: updated }));
    emit("done", updated);
    open.value = false;
  } catch (err) {
    error.value = errorOf(err, t("userLimits.bulk.failed"));
    confirming.value = false;
  } finally {
    busy.value = false;
  }
}

const invalidClass = "!border-danger/60 focus:!ring-danger/20";
</script>

<template>
  <UiModal v-model:open="open" width="md" :persistent="busy" :title="t('userLimits.bulk.title')">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="gauge" :size="15" /></span>
    </template>

    <form id="bulk-user-limits" class="space-y-5" novalidate @submit.prevent="submit">
      <div>
        <p class="label">{{ t("userLimits.bulk.scope") }}</p>
        <SegmentedControl v-model="scope" :options="scopeOptions" size="md" block />
        <p v-if="tooMany" class="hint !text-danger">{{ t("userLimits.bulk.tooMany", { max: USER_BATCH_MAX }) }}</p>
        <p v-else-if="scope === 'all'" class="hint !text-warning">{{ t("userLimits.bulk.allWarning") }}</p>
      </div>

      <!-- RPM -->
      <fieldset class="rounded-lg border border-line/80 p-3.5 transition-colors duration-200" :class="rpmOn ? 'bg-accent/[0.03]' : 'bg-surface-2/40'">
        <legend class="sr-only">{{ t("userLimits.bulk.rpm") }}</legend>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="flex items-center gap-1.5 text-sm font-medium text-fg">
              <UiIcon name="gauge" :size="14" class="text-accent" />
              {{ t("userLimits.bulk.rpm") }}
            </p>
            <p class="mt-0.5 text-xs text-fg-subtle">
              {{ t("userLimits.bulk.defaultIs", { value: defaults ? capText(defaults.rpm, "rpm") : "—" }) }}
            </p>
          </div>
          <UiSwitch v-model="rpmOn" tone="accent" :label="t('userLimits.bulk.rpm')" hide-label />
        </div>
        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="-translate-y-1 opacity-0"
        >
          <div v-if="rpmOn" class="mt-3 space-y-2">
            <SegmentedControl v-model="rpmMode" :options="rpmOptions" block />
            <div v-if="rpmMode === 'set'">
              <label for="bulk-rpm" class="sr-only">{{ t("userLimits.bulk.rpm") }}</label>
              <input
                id="bulk-rpm"
                v-model="rpmText"
                type="number"
                inputmode="numeric"
                min="1"
                :max="USER_LIMIT_MAX"
                step="1"
                :placeholder="t('userLimits.bulk.rpmPlaceholder')"
                class="input font-mono"
                :class="rpmInvalid ? invalidClass : ''"
                :aria-invalid="rpmInvalid || undefined"
              />
              <p v-if="rpmInvalid" class="hint !text-danger">{{ t("userLimits.capField.invalid", { max: USER_LIMIT_MAX.toLocaleString() }) }}</p>
            </div>
          </div>
        </Transition>
      </fieldset>

      <!-- Concurrency -->
      <fieldset class="rounded-lg border border-line/80 p-3.5 transition-colors duration-200" :class="concOn ? 'bg-accent/[0.03]' : 'bg-surface-2/40'">
        <legend class="sr-only">{{ t("userLimits.bulk.concurrency") }}</legend>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="flex items-center gap-1.5 text-sm font-medium text-fg">
              <UiIcon name="activity" :size="14" class="text-accent" />
              {{ t("userLimits.bulk.concurrency") }}
            </p>
            <p class="mt-0.5 text-xs text-fg-subtle">
              {{ t("userLimits.bulk.defaultIs", { value: defaults ? capText(defaults.concurrency, "concurrency") : "—" }) }}
            </p>
          </div>
          <UiSwitch v-model="concOn" tone="accent" :label="t('userLimits.bulk.concurrency')" hide-label />
        </div>
        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="-translate-y-1 opacity-0"
        >
          <div v-if="concOn" class="mt-3 space-y-2">
            <SegmentedControl v-model="concMode" :options="concOptions" block />
            <div v-if="concMode === 'set' || concMode === 'add'">
              <label for="bulk-conc" class="sr-only">{{ t("userLimits.bulk.concurrency") }}</label>
              <input
                id="bulk-conc"
                v-model="concText"
                type="number"
                inputmode="numeric"
                :min="concMode === 'add' ? -USER_LIMIT_MAX : 1"
                :max="USER_LIMIT_MAX"
                step="1"
                :placeholder="concMode === 'add' ? t('userLimits.bulk.addPlaceholder') : t('userLimits.bulk.concPlaceholder')"
                class="input font-mono"
                :class="concInvalid ? invalidClass : ''"
                :aria-invalid="concInvalid || undefined"
              />
              <p class="hint" :class="concInvalid ? '!text-danger' : ''">
                {{ concInvalid ? t("userLimits.bulk.concInvalid") : concMode === "add" ? t("userLimits.bulk.addHint") : t("userLimits.bulk.setHint") }}
              </p>
            </div>
          </div>
        </Transition>
      </fieldset>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="confirming" tone="warning" :title="t('userLimits.bulk.reviewTitle', { n: targetCount })">
          {{ summary }}
        </UiAlert>
      </Transition>
      <UiAlert v-if="error" tone="danger" class="animate-fade-in">{{ error }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
      <button
        type="submit"
        form="bulk-user-limits"
        class="btn"
        :class="confirming ? 'btn-danger-solid' : 'btn-primary'"
        :disabled="!ready"
      >
        <UiIcon :name="busy ? 'loader' : confirming ? 'alert' : 'check'" :size="15" :spin="busy" />
        {{ busy ? t("common.saving") : confirming ? t("userLimits.bulk.confirm", { n: targetCount }) : t("userLimits.bulk.review") }}
      </button>
    </template>
  </UiModal>
</template>
