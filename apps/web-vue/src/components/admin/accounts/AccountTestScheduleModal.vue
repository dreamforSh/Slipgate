<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountTestResult, AccountTestScheduleItem, UpstreamAccount } from "@slipgate/contracts";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSelect from "../../ui/UiSelect.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";
import { useAccountModels } from "./accountModels";

/**
 * Per-account scheduled test (sub2api "定时测试"): every N minutes slipgate tests this account,
 * whatever its status, records the result, and with auto-recover ends a cooldown after a pass.
 */
const props = defineProps<{
  open: boolean;
  account: UpstreamAccount | null;
  schedule: AccountTestScheduleItem | null;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "changed"): void }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const models = useAccountModels();

const INTERVALS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];
const enabled = ref(true);
const interval = ref(60);
const model = ref("");
const autoRecover = ref(true);
const saving = ref(false);
const running = ref(false);
const lastRun = ref<AccountTestResult | null>(null);

const suggestions = computed(() => models.suggestions(props.account?.platform));
const datalistId = computed(() => `schedule-models-${props.account?.id ?? "none"}`);

// Reset only when the dialog opens (or switches account), not when the list refresh replaces `schedule`.
watch(
  () => (props.open ? (props.account?.id ?? "") : null),
  (key) => {
    if (key === null) return;
    const s = props.schedule;
    enabled.value = s?.enabled ?? true;
    interval.value = s?.intervalMinutes ?? 60;
    model.value = s?.model ?? "";
    autoRecover.value = s?.autoRecover ?? true;
    lastRun.value = null;
    models.show(props.account?.id);
  },
  { immediate: true },
);

const intervalLabel = (m: number) =>
  m % 1440 === 0 ? t("accounts.schedule.everyDays", { n: m / 1440 }) : m % 60 === 0 ? t("accounts.schedule.everyHours", { n: m / 60 }) : t("accounts.schedule.everyMinutes", { n: m });

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  return data.message ?? `HTTP ${res.status}`;
}

async function save() {
  const acc = props.account;
  if (!acc || saving.value) return;
  saving.value = true;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/test-schedule`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enabled.value, intervalMinutes: interval.value, model: model.value.trim(), autoRecover: autoRecover.value }),
    });
    if (!res.ok) {
      toast.error(t("accounts.schedule.saveFailed", { message: await readError(res) }));
      return;
    }
    toast.success(t("accounts.schedule.saved", { name: acc.name }));
    emit("changed");
    emit("update:open", false);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const acc = props.account;
  if (!acc) return;
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/test-schedule`, { method: "DELETE" });
  if (!res.ok) {
    toast.error(t("accounts.schedule.saveFailed", { message: await readError(res) }));
    return;
  }
  toast.success(t("accounts.schedule.deleted", { name: acc.name }));
  emit("changed");
  emit("update:open", false);
}

async function runNow() {
  const acc = props.account;
  if (!acc || running.value) return;
  running.value = true;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/test-schedule/run`, { method: "POST" });
    if (!res.ok) {
      toast.error(t("accounts.schedule.runFailed", { message: await readError(res) }));
      return;
    }
    const body = (await res.json()) as { result: AccountTestResult; recovered: boolean };
    lastRun.value = body.result;
    if (body.recovered) toast.success(t("accounts.schedule.recovered", { name: acc.name }));
    emit("changed");
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" :title="t('accounts.schedule.title')" width="md" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="clock" :size="15" /></span>
    </template>

    <div v-if="account" class="space-y-4">
      <p class="text-xs text-fg-muted">{{ t("accounts.schedule.hint", { name: account.name }) }}</p>

      <div class="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
        <span class="text-sm font-medium text-fg">{{ t("accounts.schedule.enabled") }}</span>
        <UiSwitch v-model="enabled" :label="t('accounts.schedule.enabled')" hide-label />
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="label" for="schedule-interval">{{ t("accounts.schedule.interval") }}</label>
          <UiSelect id="schedule-interval" v-model="interval" class="select">
            <option v-for="m in INTERVALS" :key="m" :value="m">{{ intervalLabel(m) }}</option>
          </UiSelect>
        </div>
        <div class="min-w-0">
          <div class="label flex items-center justify-between gap-2">
            <label :for="datalistId">{{ t("accounts.test.model") }}</label>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline disabled:opacity-50"
              :disabled="models.loading.value"
              @click="models.load(account.id)"
            >
              <UiIcon :name="models.loading.value ? 'loader' : 'download'" :size="11" :spin="models.loading.value" />
              {{ models.result.value ? t("accounts.models.refetch") : t("accounts.models.fetch") }}
            </button>
          </div>
          <input
            :id="datalistId"
            v-model="model"
            type="text"
            class="input font-mono text-xs"
            :list="`${datalistId}-list`"
            :placeholder="t('accounts.schedule.defaultModel')"
            spellcheck="false"
            autocomplete="off"
          />
          <datalist :id="`${datalistId}-list`">
            <option v-for="m in suggestions" :key="m" :value="m" />
          </datalist>
          <p v-if="models.result.value" class="mt-1 truncate text-2xs text-fg-subtle" :title="models.result.value.message || undefined">
            {{
              models.result.value.source === "upstream"
                ? t("accounts.models.fromUpstream", { n: models.result.value.models.length })
                : t("accounts.models.fallback", { message: models.result.value.message })
            }}
          </p>
        </div>
      </div>

      <div class="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
        <div class="min-w-0">
          <p class="text-sm font-medium text-fg">{{ t("accounts.schedule.autoRecover") }}</p>
          <p class="mt-0.5 text-2xs text-fg-subtle">{{ t("accounts.schedule.autoRecoverHint") }}</p>
        </div>
        <UiSwitch v-model="autoRecover" :label="t('accounts.schedule.autoRecover')" hide-label />
      </div>

      <div v-if="schedule" class="rounded-lg bg-surface-2/60 px-3 py-2 text-2xs text-fg-muted">
        <p>
          {{ t("accounts.schedule.lastRun") }}:
          <span class="font-mono">{{ schedule.lastRunAtIso ? formatRelative(schedule.lastRunAtIso) : t("accounts.schedule.never") }}</span>
          <template v-if="schedule.nextRunAtIso">
            · {{ t("accounts.schedule.nextRun") }}: <span class="font-mono" :title="formatDateTime(schedule.nextRunAtIso)">{{ formatRelative(schedule.nextRunAtIso) }}</span>
          </template>
        </p>
        <p v-if="lastRun" class="mt-1" :class="lastRun.ok ? 'text-success' : 'text-danger'">
          {{ lastRun.ok ? t("accounts.schedule.runOk", { model: lastRun.model }) : t("accounts.schedule.runBad", { message: lastRun.message }) }}
        </p>
      </div>
    </div>

    <template #footer>
      <ConfirmButton
        v-if="schedule"
        class="mr-auto"
        size="sm"
        :label="t('accounts.schedule.delete')"
        :confirm-label="t('accounts.schedule.deleteConfirm')"
        @confirm="remove"
      />
      <button v-if="schedule" type="button" class="btn btn-secondary" :disabled="running" @click="runNow">
        <UiIcon :name="running ? 'loader' : 'play'" :size="14" :spin="running" />
        {{ t("accounts.schedule.runNow") }}
      </button>
      <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
        <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
        {{ t("accounts.schedule.save") }}
      </button>
    </template>
  </UiModal>
</template>
