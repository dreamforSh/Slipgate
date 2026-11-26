<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ACCOUNT_TEST_PLANS_PER_ACCOUNT,
  type AccountTestPlan,
  type AccountTestPlansResponse,
  type AccountTestResult,
  type UpstreamAccount,
} from "@slipgate/contracts";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import { browserZone, formatInZone } from "../db-backups/dbBackupUtil";
import AccountTestHistory from "./AccountTestHistory.vue";
import AccountTestPlanForm from "./AccountTestPlanForm.vue";

/**
 * Scheduled test plans of one account (sub2api "定时测试计划"): several cron plans, each with its
 * model, time zone, kept results and auto-recover; run now, pause, edit, delete, and browse a plan's
 * results.
 */
const props = defineProps<{ open: boolean; account: UpstreamAccount | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "changed"): void }>();

const { t } = useI18n();
const toast = useToastStore();

const plans = ref<AccountTestPlan[]>([]);
const loading = ref(false);
const loadError = ref("");
/** null = the list; "new" = the create form; a plan = its edit form. */
const editing = ref<AccountTestPlan | "new" | null>(null);
const expanded = ref<string | null>(null);
const busy = ref<Set<string>>(new Set());
const lastRun = ref<Record<string, AccountTestResult>>({});
const now = ref(Date.now());

const atLimit = computed(() => plans.value.length >= ACCOUNT_TEST_PLANS_PER_ACCOUNT);
const title = computed(() =>
  editing.value === "new" ? t("accounts.schedule.createTitle") : editing.value ? t("accounts.schedule.editTitle") : t("accounts.schedule.title"),
);

async function load() {
  const acc = props.account;
  if (!acc) return;
  loading.value = true;
  loadError.value = "";
  try {
    plans.value = (await apiJson<AccountTestPlansResponse>(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/test-plans`)).items;
    now.value = Date.now();
  } catch (err) {
    loadError.value = errorText(err, "HTTP error");
  } finally {
    loading.value = false;
  }
}

watch(
  () => (props.open ? (props.account?.id ?? "") : null),
  (key) => {
    if (key === null) return;
    plans.value = [];
    editing.value = null;
    expanded.value = null;
    lastRun.value = {};
    void load();
  },
  { immediate: true },
);

function replace(plan: AccountTestPlan) {
  const i = plans.value.findIndex((p) => p.id === plan.id);
  if (i >= 0) plans.value.splice(i, 1, plan);
  else plans.value.push(plan);
}

function withBusy<T>(id: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busy.value.has(id)) return Promise.resolve(undefined);
  busy.value = new Set(busy.value).add(id);
  return fn().finally(() => {
    const next = new Set(busy.value);
    next.delete(id);
    busy.value = next;
  });
}

function onSaved(plan: AccountTestPlan) {
  replace(plan);
  editing.value = null;
  emit("changed");
}

async function toggle(plan: AccountTestPlan, enabled: boolean) {
  await withBusy(plan.id, async () => {
    try {
      const res = await apiJson<{ item: AccountTestPlan }>(`/api/v1/admin/account-test-plans/${encodeURIComponent(plan.id)}`, {
        method: "PATCH",
        body: { enabled },
      });
      replace(res.item);
      emit("changed");
    } catch (err) {
      toast.error(t("accounts.schedule.saveFailed", { message: errorText(err, "HTTP error") }));
    }
  });
}

async function runNow(plan: AccountTestPlan) {
  await withBusy(plan.id, async () => {
    try {
      const res = await apiJson<{ item: AccountTestPlan; result: AccountTestResult; recovered: boolean }>(
        `/api/v1/admin/account-test-plans/${encodeURIComponent(plan.id)}/run`,
        { method: "POST" },
      );
      replace(res.item);
      lastRun.value = { ...lastRun.value, [plan.id]: res.result };
      now.value = Date.now();
      if (res.recovered) toast.success(t("accounts.schedule.recovered", { name: props.account?.name ?? "" }));
      emit("changed");
    } catch (err) {
      toast.error(t("accounts.schedule.runFailed", { message: errorText(err, "HTTP error") }));
    }
  });
}

async function remove(plan: AccountTestPlan) {
  await withBusy(plan.id, async () => {
    try {
      await apiJson(`/api/v1/admin/account-test-plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      plans.value = plans.value.filter((p) => p.id !== plan.id);
      if (expanded.value === plan.id) expanded.value = null;
      toast.success(t("accounts.schedule.deleted"));
      emit("changed");
    } catch (err) {
      toast.error(t("accounts.schedule.saveFailed", { message: errorText(err, "HTTP error") }));
    }
  });
}

/** Next run in the plan's own time zone, with the viewer's local time on hover. */
function nextRunText(plan: AccountTestPlan): string {
  return plan.nextRunAtIso ? `${formatInZone(plan.nextRunAtIso, plan.timezone)} · ${formatRelative(plan.nextRunAtIso, now.value)}` : "";
}
</script>

<template>
  <UiModal :open="open" :title="title" width="lg" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="clock" :size="15" /></span>
    </template>

    <div v-if="account" class="space-y-4">
      <AccountTestPlanForm
        v-if="editing"
        :key="editing === 'new' ? 'new' : editing.id"
        :account="account"
        :plan="editing === 'new' ? null : editing"
        @saved="onSaved"
        @cancel="editing = null"
      />

      <template v-else>
        <p class="text-xs text-fg-muted">{{ t("accounts.schedule.hint", { name: account.name }) }}</p>

        <p v-if="loadError" class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {{ t("accounts.schedule.loadFailed", { message: loadError }) }}
        </p>

        <div v-if="loading && plans.length === 0" class="flex items-center justify-center gap-2 py-10 text-xs text-fg-muted">
          <UiIcon name="loader" :size="14" spin />
        </div>

        <div v-else-if="plans.length === 0 && !loadError" class="rounded-xl border border-dashed border-line px-4 py-8 text-center">
          <UiIcon name="clock" :size="20" class="mx-auto text-fg-subtle" />
          <p class="mt-2 text-sm font-medium text-fg">{{ t("accounts.schedule.empty") }}</p>
          <p class="mx-auto mt-1 max-w-sm text-xs text-fg-muted">{{ t("accounts.schedule.emptyHint", { max: ACCOUNT_TEST_PLANS_PER_ACCOUNT }) }}</p>
          <button type="button" class="btn btn-primary btn-sm mt-4" @click="editing = 'new'">
            <UiIcon name="plus" :size="13" />
            {{ t("accounts.schedule.add") }}
          </button>
        </div>

        <ul v-else class="space-y-3">
          <li
            v-for="plan in plans"
            :key="plan.id"
            class="rounded-xl border border-line px-3 py-3 transition-opacity"
            :class="plan.enabled ? '' : 'opacity-70'"
          >
            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg">{{ plan.cronExpr }}</code>
                  <span class="text-2xs text-fg-subtle">{{ plan.timezone }}</span>
                  <UiBadge v-if="!plan.enabled" tone="neutral">{{ t("accounts.schedule.paused") }}</UiBadge>
                  <UiBadge v-if="plan.autoRecover" tone="info">{{ t("accounts.schedule.autoRecoverBadge") }}</UiBadge>
                </div>
                <p class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-fg-muted">
                  <span class="font-mono" :title="t('accounts.schedule.model')">{{ plan.model || t("accounts.schedule.defaultModelShort") }}</span>
                  <span>{{ t("accounts.schedule.keep", { n: plan.maxResults }) }}</span>
                </p>
              </div>
              <UiSwitch
                :model-value="plan.enabled"
                :label="t('accounts.schedule.enabled')"
                hide-label
                :disabled="busy.has(plan.id)"
                @update:model-value="toggle(plan, $event)"
              />
            </div>

            <dl class="mt-2 grid gap-1 text-2xs sm:grid-cols-2">
              <div class="flex min-w-0 items-center gap-1.5">
                <dt class="shrink-0 text-fg-subtle">{{ t("accounts.schedule.lastRun") }}</dt>
                <dd class="flex min-w-0 items-center gap-1">
                  <template v-if="plan.lastRunAtIso">
                    <UiIcon
                      :name="plan.lastOk ? 'check' : 'x'"
                      :size="11"
                      :class="plan.lastOk ? 'text-success' : 'text-danger'"
                      :aria-label="plan.lastOk ? t('accounts.test.history.passed') : t('accounts.test.history.failed')"
                    />
                    <span class="font-mono text-fg" :title="formatDateTime(plan.lastRunAtIso)">{{ formatRelative(plan.lastRunAtIso, now) }}</span>
                    <span v-if="!plan.lastOk && plan.lastMessage" class="truncate text-danger" :title="plan.lastMessage">{{ plan.lastMessage }}</span>
                  </template>
                  <span v-else class="text-fg-subtle">{{ t("accounts.schedule.never") }}</span>
                </dd>
              </div>
              <div class="flex min-w-0 items-center gap-1.5">
                <dt class="shrink-0 text-fg-subtle">{{ t("accounts.schedule.nextRun") }}</dt>
                <dd
                  class="truncate font-mono text-fg"
                  :title="plan.nextRunAtIso && plan.timezone !== browserZone() ? t('accounts.schedule.localTime', { time: formatInZone(plan.nextRunAtIso, browserZone()) }) : undefined"
                >
                  {{ plan.enabled ? nextRunText(plan) || t("accounts.schedule.previewNever") : "—" }}
                </dd>
              </div>
            </dl>

            <p v-if="lastRun[plan.id]" class="mt-1.5 text-2xs" :class="lastRun[plan.id]!.ok ? 'text-success' : 'text-danger'">
              {{
                lastRun[plan.id]!.ok
                  ? t("accounts.schedule.runOk", { model: lastRun[plan.id]!.model })
                  : t("accounts.schedule.runBad", { message: lastRun[plan.id]!.message })
              }}
            </p>

            <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button type="button" class="btn btn-secondary btn-sm" :disabled="busy.has(plan.id)" @click="runNow(plan)">
                <UiIcon :name="busy.has(plan.id) ? 'loader' : 'play'" :size="13" :spin="busy.has(plan.id)" />
                {{ t("accounts.schedule.runNow") }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :aria-expanded="expanded === plan.id"
                @click="expanded = expanded === plan.id ? null : plan.id"
              >
                <UiIcon name="list" :size="13" />
                {{ expanded === plan.id ? t("accounts.schedule.hideResults") : t("accounts.schedule.results") }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="busy.has(plan.id)" @click="editing = plan">
                <UiIcon name="pencil" :size="13" />
                {{ t("accounts.schedule.edit") }}
              </button>
              <ConfirmButton
                class="ml-auto"
                size="sm"
                :label="t('accounts.schedule.delete')"
                :confirm-label="t('accounts.schedule.deleteConfirm')"
                :disabled="busy.has(plan.id)"
                @confirm="remove(plan)"
              />
            </div>

            <div v-if="expanded === plan.id" class="mt-3 border-t border-line pt-3">
              <AccountTestHistory
                :key="`${plan.id}:${plan.lastRunAtIso ?? ''}`"
                :account-id="account.id"
                :plan-id="plan.id"
                :retention="plan.maxResults"
              />
            </div>
          </li>
        </ul>
      </template>
    </div>

    <template v-if="!editing && plans.length > 0" #footer>
      <span class="mr-auto text-2xs text-fg-subtle">{{ t("accounts.schedule.count", { n: plans.length, max: ACCOUNT_TEST_PLANS_PER_ACCOUNT }) }}</span>
      <button type="button" class="btn btn-primary" :disabled="atLimit" :title="atLimit ? t('accounts.schedule.limitReached', { max: ACCOUNT_TEST_PLANS_PER_ACCOUNT }) : undefined" @click="editing = 'new'">
        <UiIcon name="plus" :size="14" />
        {{ t("accounts.schedule.add") }}
      </button>
    </template>
  </UiModal>
</template>
