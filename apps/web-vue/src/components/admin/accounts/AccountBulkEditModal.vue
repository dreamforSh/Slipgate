<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  allowedSubscriptionTiersForProvider,
  type AccountBulkPatch,
  type AccountBulkResult,
  type AccountInitialStatus,
  type ExecutionMode,
  type GroupItem,
  type SubscriptionTier,
  type UpstreamAccount,
} from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { EXECUTION_MODES, dateInputFromNow, dateInputToIso } from "./accountDisplay";
import { executionModeLabel } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import UiSelect from "../../ui/UiSelect.vue";

/** Apply the same settings to many accounts; only ticked fields are sent. */
const props = defineProps<{
  open: boolean;
  accounts: UpstreamAccount[];
  groups: GroupItem[];
}>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "done", result: AccountBulkResult): void;
}>();

const { t } = useI18n();
const auth = useAuthStore();

type Field = "group" | "status" | "mode" | "tier" | "concurrency" | "priority" | "expires";
const apply = reactive<Record<Field, boolean>>({
  group: false,
  status: false,
  mode: false,
  tier: false,
  concurrency: false,
  priority: false,
  expires: false,
});

const groupId = ref("");
const status = ref<AccountInitialStatus>("active");
const executionMode = ref<ExecutionMode>("stealth_http");
const tier = ref<SubscriptionTier>("standard");
const concurrency = ref(5);
const priority = ref(100);
const expires = ref("");
const autoPause = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

/** API keys carry no plan: the tier never applies to them, so it is offered for subscriptions only. */
const subscriptionAccounts = computed(() => props.accounts.filter((a) => a.authKind !== "api_key"));
const apiKeyCount = computed(() => props.accounts.length - subscriptionAccounts.value.length);
const platforms = computed(() => [...new Set(subscriptionAccounts.value.map((a) => a.platform))]);

/** Tiers every selected subscription platform accepts, in the first platform's display order. */
const sharedTiers = computed(() => {
  const [first, ...rest] = platforms.value;
  if (!first) return [];
  return allowedSubscriptionTiersForProvider(first).filter((opt) =>
    rest.every((p) => allowedSubscriptionTiersForProvider(p).some((o) => o.tier === opt.tier)),
  );
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    for (const key of Object.keys(apply) as Field[]) apply[key] = false;
    groupId.value = props.groups[0]?.id ?? "";
    status.value = "active";
    executionMode.value = "stealth_http";
    tier.value = sharedTiers.value[0]?.tier ?? "standard";
    concurrency.value = 5;
    priority.value = 100;
    expires.value = "";
    autoPause.value = true;
    error.value = null;
  },
);

function buildPatch(): AccountBulkPatch {
  const patch: AccountBulkPatch = {};
  // "" moves the selected accounts out of their groups.
  if (apply.group) patch.groupId = groupId.value;
  if (apply.status) patch.status = status.value;
  if (apply.mode) patch.executionMode = executionMode.value;
  if (apply.tier && sharedTiers.value.length && subscriptionAccounts.value.length) patch.subscriptionTier = tier.value;
  if (apply.concurrency) patch.maxConcurrency = concurrency.value;
  if (apply.priority) patch.priority = priority.value;
  if (apply.expires) {
    patch.expiresAtIso = expires.value ? dateInputToIso(expires.value) : null;
    patch.autoPauseOnExpired = autoPause.value;
  }
  return patch;
}

const hasChanges = computed(() => Object.keys(buildPatch()).length > 0);

async function submit() {
  const patch = buildPatch();
  if (!Object.keys(patch).length) {
    error.value = t("accounts.bulkEdit.nothing");
    return;
  }
  saving.value = true;
  error.value = null;
  // API-key accounts get the same patch minus the tier; skip them when nothing else is left.
  const { subscriptionTier, ...keyPatch } = patch;
  const keyIds = new Set(props.accounts.filter((a) => a.authKind === "api_key").map((a) => a.id));
  const batches: { ids: string[]; patch: AccountBulkPatch }[] = [
    { ids: props.accounts.filter((a) => !keyIds.has(a.id)).map((a) => a.id), patch },
    { ids: [...keyIds], patch: subscriptionTier === undefined ? patch : keyPatch },
  ].filter((b) => b.ids.length && Object.keys(b.patch).length);
  const total: AccountBulkResult = { success: 0, failed: 0, results: [] };
  try {
    for (const batch of batches) {
      for (let offset = 0; offset < batch.ids.length; offset += 500) {
        const res = await auth.apiFetch("/api/v1/admin/accounts/bulk-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountIds: batch.ids.slice(offset, offset + 500), patch: batch.patch }),
        });
        const data = (await res.json().catch(() => ({}))) as AccountBulkResult & { message?: string };
        if (!res.ok) {
          error.value = data.message ?? t("accounts.bulk.failed");
          return;
        }
        total.success += data.success;
        total.failed += data.failed;
        total.results.push(...data.results);
      }
    }
    emit("done", total);
    emit("update:open", false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : t("accounts.bulk.failed");
  } finally {
    saving.value = false;
  }
}

const rowClass = (on: boolean) =>
  `grid grid-cols-[auto_8rem_1fr] items-center gap-3 rounded-lg px-3 py-2.5 transition-colors ${
    on ? "bg-accent/[0.06] ring-1 ring-inset ring-accent/20" : "bg-surface-2/50"
  }`;
</script>

<template>
  <UiModal
    :open="open"
    :title="t('accounts.bulkEdit.title', { count: accounts.length })"
    width="lg"
    @update:open="emit('update:open', $event)"
  >
    <p class="mb-4 text-sm text-fg-muted">{{ t("accounts.bulkEdit.hint") }}</p>
    <form id="bulk-edit-form" class="space-y-2" @submit.prevent="submit">
      <div :class="rowClass(apply.group)">
        <input id="be-group" v-model="apply.group" type="checkbox" class="checkbox" />
        <label for="be-group" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.group") }}</label>
        <UiSelect v-model="groupId" class="select input-sm" :disabled="!apply.group" :aria-label="t('accounts.bulkEdit.group')">
          <option value="">{{ t("accounts.form.noGroup") }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </UiSelect>
      </div>

      <div :class="rowClass(apply.status)">
        <input id="be-status" v-model="apply.status" type="checkbox" class="checkbox" />
        <label for="be-status" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.status") }}</label>
        <UiSelect v-model="status" class="select input-sm" :disabled="!apply.status" :aria-label="t('accounts.bulkEdit.status')">
          <option value="active">{{ t("accounts.bulk.enable") }}</option>
          <option value="paused">{{ t("accounts.bulk.pause") }}</option>
        </UiSelect>
      </div>

      <div :class="rowClass(apply.mode)">
        <input id="be-mode" v-model="apply.mode" type="checkbox" class="checkbox" />
        <label for="be-mode" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.mode") }}</label>
        <UiSelect v-model="executionMode" class="select input-sm" :disabled="!apply.mode" :aria-label="t('accounts.bulkEdit.mode')">
          <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
        </UiSelect>
      </div>

      <div v-if="subscriptionAccounts.length" :class="rowClass(apply.tier)">
        <input id="be-tier" v-model="apply.tier" type="checkbox" class="checkbox" :disabled="!sharedTiers.length" />
        <label for="be-tier" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.tier") }}</label>
        <div class="min-w-0">
          <UiSelect
            v-model="tier"
            class="select input-sm"
            :disabled="!apply.tier || !sharedTiers.length"
            :aria-label="t('accounts.bulkEdit.tier')"
          >
            <option v-for="opt in sharedTiers" :key="opt.tier" :value="opt.tier">{{ opt.label }}</option>
          </UiSelect>
          <p v-if="!sharedTiers.length" class="mt-1 text-2xs text-warning">{{ t("accounts.bulkEdit.tierUnavailable") }}</p>
          <p v-else-if="platforms.length > 1" class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.bulkEdit.tierMixed") }}</p>
          <p v-if="sharedTiers.length && apiKeyCount" class="mt-1 text-2xs text-fg-subtle">
            {{ t("accounts.bulkEdit.tierSkipsKeys", { count: apiKeyCount }) }}
          </p>
        </div>
      </div>

      <div :class="rowClass(apply.concurrency)">
        <input id="be-conc" v-model="apply.concurrency" type="checkbox" class="checkbox" />
        <label for="be-conc" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.concurrency") }}</label>
        <input
          v-model.number="concurrency"
          type="number"
          min="1"
          max="64"
          class="input input-sm font-mono"
          :disabled="!apply.concurrency"
          :aria-label="t('accounts.bulkEdit.concurrency')"
        />
      </div>

      <div :class="rowClass(apply.priority)">
        <input id="be-prio" v-model="apply.priority" type="checkbox" class="checkbox" />
        <label for="be-prio" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.priority") }}</label>
        <input
          v-model.number="priority"
          type="number"
          min="0"
          max="10000"
          class="input input-sm font-mono"
          :disabled="!apply.priority"
          :aria-label="t('accounts.bulkEdit.priority')"
        />
      </div>

      <div :class="rowClass(apply.expires)">
        <input id="be-exp" v-model="apply.expires" type="checkbox" class="checkbox" />
        <label for="be-exp" class="text-sm font-medium text-fg">{{ t("accounts.bulkEdit.expires") }}</label>
        <div class="min-w-0 space-y-2">
          <div class="flex flex-wrap items-center gap-1">
            <input
              v-model="expires"
              type="date"
              class="input input-sm w-auto font-mono"
              :disabled="!apply.expires"
              :aria-label="t('accounts.bulkEdit.expires')"
            />
            <button type="button" class="btn btn-secondary btn-xs" :disabled="!apply.expires" @click="expires = dateInputFromNow(30)">
              {{ t("accounts.form.expiresPreset.d30") }}
            </button>
            <button type="button" class="btn btn-ghost btn-xs" :disabled="!apply.expires" @click="expires = ''">
              {{ t("accounts.form.expiresClear") }}
            </button>
          </div>
          <UiSwitch v-model="autoPause" tone="accent" :disabled="!apply.expires" :label="t('accounts.bulkEdit.autoPause')" />
        </div>
      </div>
      <p v-if="error" class="pt-1 text-sm text-danger">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="bulk-edit-form" class="btn btn-primary" :disabled="saving || !hasChanges">
        <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
        {{ t("accounts.bulkEdit.apply", { count: accounts.length }) }}
      </button>
    </template>
  </UiModal>
</template>
