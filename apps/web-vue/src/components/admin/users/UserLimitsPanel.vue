<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { AdminUpdateUserRequest, AdminUserItem, AdminUserRpmStatus, UserCap } from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UserCapField from "./UserCapField.vue";
import { loadPortalCapDefaults, sameCap, useLimitText, type PortalCapDefaults } from "./limits";

/**
 * One user's own caps (edit) and where they stand right now (GET rpm-status): the current
 * minute's requests and in-flight requests against the user cap and each group's cap.
 * Polls every 10 s while `active`.
 */
const props = defineProps<{ user: AdminUserItem; active: boolean }>();
const emit = defineEmits<{ (e: "saved", user: AdminUserItem): void }>();

const { t, capText, errorOf } = useLimitText();
const toast = useToastStore();

/* ---------------- Caps editor ---------------- */

const rpm = ref<UserCap>(null);
const concurrency = ref<UserCap>(null);
const rpmInvalid = ref(false);
const concInvalid = ref(false);
const saving = ref(false);
const saveError = ref<string | null>(null);
const defaults = ref<PortalCapDefaults | null>(null);

function resetCaps() {
  rpm.value = props.user.rpmLimit ?? null;
  concurrency.value = props.user.concurrencyLimit ?? null;
  saveError.value = null;
}

watch(
  () => props.user.id,
  () => {
    resetCaps();
    status.value = null;
    statusError.value = null;
  },
);
resetCaps();

const dirty = computed(
  () => !sameCap(rpm.value, props.user.rpmLimit) || !sameCap(concurrency.value, props.user.concurrencyLimit),
);

async function saveCaps() {
  if (!dirty.value || saving.value || rpmInvalid.value || concInvalid.value) return;
  saving.value = true;
  saveError.value = null;
  const body: AdminUpdateUserRequest = {};
  if (!sameCap(rpm.value, props.user.rpmLimit)) body.rpmLimit = rpm.value;
  if (!sameCap(concurrency.value, props.user.concurrencyLimit)) body.concurrencyLimit = concurrency.value;
  try {
    const res = await apiJson<{ user: AdminUserItem }>(`/api/v1/admin/users/${encodeURIComponent(props.user.id)}`, {
      method: "PATCH",
      body,
    });
    toast.success(t("userLimits.panel.saved"));
    emit("saved", res.user);
    void loadStatus(true);
  } catch (err) {
    saveError.value = errorOf(err, t("userLimits.panel.saveFailed"));
  } finally {
    saving.value = false;
  }
}

/* ---------------- Live status ---------------- */

const status = ref<AdminUserRpmStatus | null>(null);
const statusLoading = ref(false);
const statusError = ref<string | null>(null);
let seq = 0;
let timer: number | undefined;

async function loadStatus(quiet = false) {
  const id = ++seq;
  if (!quiet) statusLoading.value = true;
  try {
    const res = await apiJson<AdminUserRpmStatus>(`/api/v1/admin/users/${encodeURIComponent(props.user.id)}/rpm-status`);
    if (id !== seq) return;
    status.value = res;
    statusError.value = null;
  } catch (err) {
    if (id === seq) statusError.value = errorOf(err, t("userLimits.panel.statusFailed"));
  } finally {
    if (id === seq) statusLoading.value = false;
  }
}

function schedule(on: boolean) {
  window.clearInterval(timer);
  timer = undefined;
  if (!on) return;
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadStatus(true);
  }, 10_000);
}

watch(
  () => [props.active, props.user.id] as const,
  async ([active]) => {
    schedule(active);
    if (active) {
      void loadStatus(status.value !== null);
      defaults.value = await loadPortalCapDefaults();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => schedule(false));

function pct(used: number | null, limit: number): number {
  if (used === null || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}
function barTone(used: number | null, limit: number): string {
  const p = pct(used, limit);
  return p >= 95 ? "bg-danger" : p >= 75 ? "bg-warning" : "bg-accent";
}

const sourceTone: Record<"override" | "group" | "none", string> = {
  override: "bg-violet/10 text-violet ring-violet/20",
  group: "bg-accent/10 text-accent ring-accent/20",
  none: "bg-surface-2 text-fg-subtle ring-line",
};
</script>

<template>
  <div class="space-y-6">
    <!-- Own caps -->
    <section class="space-y-4">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <p class="eyebrow">{{ t("userLimits.panel.capsTitle") }}</p>
        <span class="text-2xs text-fg-subtle">{{ t("userLimits.panel.capsHint") }}</span>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <UserCapField
          id="ud-rpm"
          v-model="rpm"
          v-model:invalid="rpmInvalid"
          kind="rpm"
          :label="t('userLimits.fields.rpm')"
          :portal-default="defaults?.rpm ?? null"
          :disabled="saving"
        />
        <UserCapField
          id="ud-conc"
          v-model="concurrency"
          v-model:invalid="concInvalid"
          kind="concurrency"
          :label="t('userLimits.fields.concurrency')"
          :portal-default="defaults?.concurrency ?? null"
          :disabled="saving"
        />
      </div>
      <UiAlert v-if="saveError" tone="danger" class="animate-fade-in">{{ saveError }}</UiAlert>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Transition
          enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
        >
          <span v-if="dirty" class="mr-auto inline-flex items-center gap-1.5 text-xs text-warning">
            <span class="h-1.5 w-1.5 rounded-full bg-warning" />{{ t("userLimits.panel.unsaved") }}
          </span>
        </Transition>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="!dirty || saving" @click="resetCaps">
          <UiIcon name="rotate-ccw" :size="13" />{{ t("userLimits.panel.discard") }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="!dirty || saving || rpmInvalid || concInvalid"
          @click="saveCaps"
        >
          <UiIcon :name="saving ? 'loader' : 'check'" :size="13" :spin="saving" />
          {{ saving ? t("common.saving") : t("userLimits.panel.save") }}
        </button>
      </div>
    </section>

    <!-- Live status -->
    <section class="space-y-3 border-t border-line/70 pt-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="eyebrow">{{ t("userLimits.panel.statusTitle") }}</p>
        <div class="flex items-center gap-2">
          <span
            v-if="status"
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset"
            :class="status.live ? 'bg-success/10 text-success ring-success/20' : 'bg-surface-2 text-fg-subtle ring-line'"
            :title="status.live ? t('userLimits.live.liveHint') : t('userLimits.live.offlineHint')"
          >
            <span class="relative inline-flex h-1.5 w-1.5">
              <span v-if="status.live" class="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full" :class="status.live ? 'bg-success' : 'bg-fg-subtle'" />
            </span>
            {{ status.live ? t("userLimits.live.live") : t("userLimits.live.estimated") }}
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-xs"
            :disabled="statusLoading"
            :title="t('common.refresh')"
            :aria-label="t('common.refresh')"
            @click="loadStatus()"
          >
            <UiIcon name="refresh" :size="13" :spin="statusLoading" />
          </button>
        </div>
      </div>

      <UiAlert v-if="statusError && !status" tone="danger">
        {{ statusError }}
        <template #action>
          <button type="button" class="btn btn-secondary btn-xs" @click="loadStatus()">{{ t("userLimits.common.retry") }}</button>
        </template>
      </UiAlert>

      <div v-else-if="!status" class="grid gap-3 sm:grid-cols-2" aria-busy="true">
        <div v-for="i in 2" :key="i" class="rounded-lg border border-line/70 p-3.5 motion-safe:animate-pulse">
          <span class="block h-2.5 w-20 rounded-full bg-surface-2" />
          <span class="mt-3 block h-5 w-24 rounded bg-surface-2" />
          <span class="mt-3 block h-1.5 w-full rounded-full bg-surface-2" />
        </div>
      </div>

      <template v-else>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-lg border border-line/70 bg-surface-2/30 p-3.5">
            <p class="flex items-center gap-1.5 text-xs text-fg-subtle"><UiIcon name="gauge" :size="13" />{{ t("userLimits.panel.rpmNow") }}</p>
            <p class="mt-1.5 font-mono text-lg font-semibold tabular-nums text-fg">
              {{ status.rpm.used }}
              <span class="text-sm font-normal text-fg-subtle">/ {{ capText(status.rpm.limit, "rpm") }}</span>
            </p>
            <div v-if="status.rpm.limit > 0" class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                class="h-full rounded-full transition-[width] duration-500 ease-out"
                :class="barTone(status.rpm.used, status.rpm.limit)"
                :style="{ width: `${pct(status.rpm.used, status.rpm.limit)}%` }"
              />
            </div>
          </div>
          <div class="rounded-lg border border-line/70 bg-surface-2/30 p-3.5">
            <p class="flex items-center gap-1.5 text-xs text-fg-subtle"><UiIcon name="activity" :size="13" />{{ t("userLimits.panel.inFlight") }}</p>
            <p class="mt-1.5 font-mono text-lg font-semibold tabular-nums text-fg">
              {{ status.concurrency.inFlight ?? "—" }}
              <span class="text-sm font-normal text-fg-subtle">/ {{ capText(status.concurrency.limit, "concurrency") }}</span>
            </p>
            <div v-if="status.concurrency.limit > 0" class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                class="h-full rounded-full transition-[width] duration-500 ease-out"
                :class="barTone(status.concurrency.inFlight, status.concurrency.limit)"
                :style="{ width: `${pct(status.concurrency.inFlight, status.concurrency.limit)}%` }"
              />
            </div>
          </div>
        </div>

        <p v-if="!status.live" class="flex items-start gap-1.5 text-xs text-fg-subtle">
          <UiIcon name="info" :size="12" class="mt-0.5" />{{ t("userLimits.live.offlineHint") }}
        </p>

        <div v-if="status.groups.length" class="overflow-hidden rounded-lg border border-line/70">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t("userLimits.panel.group") }}</th>
                  <th class="text-right">{{ t("userLimits.panel.groupRpm") }}</th>
                  <th class="text-right">{{ t("userLimits.panel.groupConcurrency") }}</th>
                </tr>
              </thead>
              <TransitionGroup tag="tbody" move-class="transition-transform duration-200 ease-out motion-reduce:transition-none">
                <tr v-for="g in status.groups" :key="g.groupId">
                  <td class="max-w-[12rem]"><p class="truncate text-sm font-medium text-fg" :title="g.groupName">{{ g.groupName }}</p></td>
                  <td class="whitespace-nowrap text-right">
                    <span class="font-mono text-xs tabular-nums text-fg">{{ g.rpm.used }} / {{ capText(g.rpm.limit, "rpm") }}</span>
                    <span
                      class="ml-1.5 inline-flex rounded-full px-1.5 text-2xs font-medium ring-1 ring-inset"
                      :class="sourceTone[g.rpm.source]"
                      :title="t(`userLimits.panel.sourceHint.${g.rpm.source}`)"
                    >
                      {{ t(`userLimits.panel.source.${g.rpm.source}`) }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">
                    {{ g.concurrency.inFlight ?? "—" }} / {{ capText(g.concurrency.limit, "concurrency") }}
                  </td>
                </tr>
              </TransitionGroup>
            </table>
          </div>
        </div>
        <p v-else class="rounded-lg border border-dashed border-line px-3.5 py-3 text-center text-xs text-fg-subtle">
          {{ t("userLimits.panel.noGroups") }}
        </p>
      </template>
    </section>
  </div>
</template>
