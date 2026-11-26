<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ACCOUNT_TEST_PLAN_RESULTS_DEFAULT,
  ACCOUNT_TEST_PLAN_RESULTS_MAX,
  type AccountTestPlan,
  type AccountTestPlanCronPreview,
  type UpstreamAccount,
} from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { apiJson, errorText, toQuery } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import { browserZone, formatInZone, isKnownZone, timeZones } from "../db-backups/dbBackupUtil";
import { useAccountModels } from "./accountModels";

/**
 * Create / edit one scheduled test plan: model, cron expression (presets + live preview of the next
 * runs, checked by the server exactly as saving does), time zone, kept results, enabled and
 * auto-recover.
 */
const props = defineProps<{ account: UpstreamAccount; plan: AccountTestPlan | null }>();
const emit = defineEmits<{ (e: "saved", plan: AccountTestPlan): void; (e: "cancel"): void }>();

const { t } = useI18n();
const toast = useToastStore();
const models = useAccountModels();

const PRESETS = [
  { key: "every5m", expr: "*/5 * * * *" },
  { key: "every30m", expr: "*/30 * * * *" },
  { key: "hourly", expr: "0 * * * *" },
  { key: "daily9", expr: "0 9 * * *" },
  { key: "weekdays9", expr: "0 9 * * 1-5" },
  { key: "weekly", expr: "0 9 * * 1" },
] as const;

const model = ref(props.plan?.model ?? "");
const cronExpr = ref(props.plan?.cronExpr ?? "*/30 * * * *");
const timezone = ref(props.plan?.timezone ?? browserZone());
const maxResults = ref(props.plan?.maxResults ?? ACCOUNT_TEST_PLAN_RESULTS_DEFAULT);
const enabled = ref(props.plan?.enabled ?? true);
const autoRecover = ref(props.plan?.autoRecover ?? false);
const saving = ref(false);

const zones = timeZones();
const uid = `plan-${props.plan?.id ?? "new"}`;
const suggestions = computed(() => models.suggestions(props.account.platform));
models.show(props.account.id);

/* ---------------- Live preview (debounced; the server parses as it will on save) ---------------- */
const preview = ref<AccountTestPlanCronPreview | null>(null);
const checking = ref(false);
let timer: number | undefined;
let seq = 0;

function schedulePreview() {
  window.clearTimeout(timer);
  const expr = cronExpr.value.trim();
  const zone = timezone.value.trim();
  if (!expr) {
    preview.value = null;
    return;
  }
  checking.value = true;
  timer = window.setTimeout(async () => {
    const mine = ++seq;
    try {
      const res = await apiJson<AccountTestPlanCronPreview>(
        `/api/v1/admin/account-test-plans/cron-preview${toQuery({ cronExpr: expr, timezone: zone || "UTC", count: 3 })}`,
      );
      if (mine === seq) preview.value = res;
    } catch {
      if (mine === seq) preview.value = null;
    } finally {
      if (mine === seq) checking.value = false;
    }
  }, 300);
}
watch([cronExpr, timezone], schedulePreview, { immediate: true });
onBeforeUnmount(() => window.clearTimeout(timer));

const previewError = computed(() => {
  const p = preview.value;
  if (!p || p.valid) return "";
  return p.error === "invalid_timezone" ? t("accounts.schedule.invalidTimezone", { message: p.message }) : t("accounts.schedule.invalidCron", { message: p.message });
});
const zoneOk = computed(() => isKnownZone(timezone.value.trim()));
const sameZone = computed(() => timezone.value.trim() === browserZone());
const maxResultsOk = computed(() => Number.isInteger(maxResults.value) && maxResults.value >= 1 && maxResults.value <= ACCOUNT_TEST_PLAN_RESULTS_MAX);
const canSave = computed(() => !saving.value && cronExpr.value.trim() !== "" && zoneOk.value && maxResultsOk.value && preview.value?.valid !== false);

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  const body = {
    model: model.value.trim(),
    cronExpr: cronExpr.value.trim(),
    timezone: timezone.value.trim(),
    maxResults: maxResults.value,
    enabled: enabled.value,
    autoRecover: autoRecover.value,
  };
  try {
    const res = props.plan
      ? await apiJson<{ item: AccountTestPlan }>(`/api/v1/admin/account-test-plans/${encodeURIComponent(props.plan.id)}`, { method: "PATCH", body })
      : await apiJson<{ item: AccountTestPlan }>(`/api/v1/admin/accounts/${encodeURIComponent(props.account.id)}/test-plans`, { method: "POST", body });
    toast.success(t("accounts.schedule.saved"));
    emit("saved", res.item);
  } catch (err) {
    toast.error(t("accounts.schedule.saveFailed", { message: errorText(err, "HTTP error") }));
  } finally {
    saving.value = false;
  }
}

defineExpose({ save, canSave, saving });
</script>

<template>
  <form class="space-y-4" @submit.prevent="save">
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="min-w-0">
        <div class="label flex items-center justify-between gap-2">
          <label :for="`${uid}-model`">{{ t("accounts.schedule.model") }}</label>
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
          :id="`${uid}-model`"
          v-model="model"
          type="text"
          class="input font-mono text-xs"
          :list="`${uid}-models`"
          :placeholder="t('accounts.schedule.defaultModel')"
          spellcheck="false"
          autocomplete="off"
        />
        <datalist :id="`${uid}-models`">
          <option v-for="m in suggestions" :key="m" :value="m" />
        </datalist>
      </div>
      <div class="min-w-0">
        <label class="label" :for="`${uid}-tz`">{{ t("accounts.schedule.timezone") }}</label>
        <input
          :id="`${uid}-tz`"
          v-model="timezone"
          type="text"
          class="input font-mono text-xs"
          :class="zoneOk ? '' : '!border-danger'"
          :list="`${uid}-zones`"
          spellcheck="false"
          autocomplete="off"
        />
        <datalist :id="`${uid}-zones`">
          <option v-for="z in zones" :key="z" :value="z" />
        </datalist>
      </div>
    </div>

    <div>
      <label class="label" :for="`${uid}-cron`">{{ t("accounts.schedule.cron") }}</label>
      <input
        :id="`${uid}-cron`"
        v-model="cronExpr"
        type="text"
        class="input font-mono text-sm"
        :class="previewError ? '!border-danger' : ''"
        spellcheck="false"
        autocomplete="off"
        placeholder="*/30 * * * *"
      />
      <div class="mt-2 flex flex-wrap gap-1.5">
        <button
          v-for="p in PRESETS"
          :key="p.key"
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-2xs transition-colors"
          :class="cronExpr.trim() === p.expr ? 'border-accent bg-accent/10 text-accent' : 'border-line text-fg-muted hover:border-accent/50 hover:text-fg'"
          :title="p.expr"
          @click="cronExpr = p.expr"
        >
          {{ t(`accounts.schedule.presets.${p.key}`) }}
        </button>
      </div>
      <p class="mt-1.5 text-2xs text-fg-subtle">{{ t("accounts.schedule.cronHelp") }}</p>

      <div class="mt-2 rounded-lg bg-surface-2/60 px-3 py-2 text-2xs" aria-live="polite">
        <p v-if="previewError" class="text-danger">{{ previewError }}</p>
        <template v-else-if="preview?.valid">
          <p v-if="preview.runsIso.length === 0" class="text-warning">{{ t("accounts.schedule.previewNever") }}</p>
          <template v-else>
            <p class="mb-1 font-medium text-fg-muted">{{ t("accounts.schedule.preview") }}</p>
            <ol class="space-y-0.5">
              <li v-for="iso in preview.runsIso" :key="iso" class="flex flex-wrap items-baseline gap-x-2 font-mono tabular-nums text-fg">
                <span>{{ formatInZone(iso, timezone.trim()) }}</span>
                <span class="text-fg-subtle">{{ formatRelative(iso) }}</span>
                <span v-if="!sameZone" class="text-fg-subtle">· {{ t("accounts.schedule.localTime", { time: formatInZone(iso, browserZone()) }) }}</span>
              </li>
            </ol>
          </template>
        </template>
        <p v-else class="text-fg-subtle">{{ checking ? t("accounts.schedule.previewChecking") : "—" }}</p>
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class="label" :for="`${uid}-keep`">{{ t("accounts.schedule.maxResults") }}</label>
        <input
          :id="`${uid}-keep`"
          v-model.number="maxResults"
          type="number"
          min="1"
          :max="ACCOUNT_TEST_PLAN_RESULTS_MAX"
          class="input font-mono text-xs"
          :class="maxResultsOk ? '' : '!border-danger'"
        />
        <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.schedule.maxResultsHint", { max: ACCOUNT_TEST_PLAN_RESULTS_MAX }) }}</p>
      </div>
      <div class="flex items-center justify-between gap-3 self-start rounded-lg border border-line px-3 py-2.5 sm:mt-6">
        <span class="text-sm font-medium text-fg">{{ t("accounts.schedule.enabled") }}</span>
        <UiSwitch v-model="enabled" :label="t('accounts.schedule.enabled')" hide-label />
      </div>
    </div>

    <div class="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
      <div class="min-w-0">
        <p class="text-sm font-medium text-fg">{{ t("accounts.schedule.autoRecover") }}</p>
        <p class="mt-0.5 text-2xs text-fg-subtle">{{ t("accounts.schedule.autoRecoverHint") }}</p>
      </div>
      <UiSwitch v-model="autoRecover" :label="t('accounts.schedule.autoRecover')" hide-label />
    </div>

    <div class="flex justify-end gap-2 border-t border-line pt-3">
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="emit('cancel')">
        {{ t("accounts.schedule.cancel") }}
      </button>
      <button type="submit" class="btn btn-primary" :disabled="!canSave">
        <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
        {{ t("accounts.schedule.save") }}
      </button>
    </div>
  </form>
</template>
