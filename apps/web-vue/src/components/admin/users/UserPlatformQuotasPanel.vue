<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  parseUsdToNano,
  type AdminUserItem,
  type GroupPlatform,
  type QuotaResetWindow,
  type UserPlatformQuotaItem,
  type UserPlatformQuotasResponse,
} from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { formatUsd, PROVIDER_OPTIONS } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { nanoToUsdInput, normalizeUsdInput } from "../ops/opsUtil";
import { useLimitText } from "./limits";

const props = defineProps<{ user: AdminUserItem; active: boolean }>();
const emit = defineEmits<{ (e: "saved"): void }>();

const { t } = useI18n();
const { errorOf } = useLimitText();
const toast = useToastStore();

const items = ref<UserPlatformQuotaItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);
const busyPlatform = ref<string | null>(null);
const saveError = ref<string | null>(null);

const platformOptions = computed<{ value: GroupPlatform; label: string }[]>(() => [
  ...PROVIDER_OPTIONS,
  { value: "composite", label: t("accounts.platforms.composite") },
]);

const form = reactive<{
  platform: GroupPlatform;
  dailyUsd: string;
  weeklyUsd: string;
  monthlyUsd: string;
}>({
  platform: "anthropic",
  dailyUsd: "0",
  weeklyUsd: "0",
  monthlyUsd: "0",
});

let seq = 0;
async function load() {
  const id = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await apiJson<UserPlatformQuotasResponse>(
      `/api/v1/admin/users/${encodeURIComponent(props.user.id)}/platform-quotas`,
    );
    if (id !== seq) return;
    items.value = res.items;
    loaded.value = true;
  } catch (err) {
    if (id === seq) loadError.value = errorOf(err, t("userLimits.quotas.loadFailed"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch(
  () => [props.active, props.user.id] as const,
  ([active], prev) => {
    const userChanged = prev && prev[1] !== props.user.id;
    if (userChanged) {
      loaded.value = false;
      items.value = [];
    }
    if (active && (!loaded.value || userChanged)) void load();
  },
  { immediate: true },
);

function editItem(item: UserPlatformQuotaItem) {
  form.platform = item.platform;
  form.dailyUsd = nanoToUsdInput(item.dailyLimitNanoUsd) || "0";
  form.weeklyUsd = nanoToUsdInput(item.weeklyLimitNanoUsd) || "0";
  form.monthlyUsd = nanoToUsdInput(item.monthlyLimitNanoUsd) || "0";
  saveError.value = null;
}

const formValid = computed(() => {
  return (
    normalizeUsdInput(form.dailyUsd || "0", true) !== null &&
    normalizeUsdInput(form.weeklyUsd || "0", true) !== null &&
    normalizeUsdInput(form.monthlyUsd || "0", true) !== null
  );
});

async function saveQuota() {
  if (saving.value || !formValid.value) return;
  saveError.value = null;
  const d = normalizeUsdInput(form.dailyUsd || "0", true);
  const w = normalizeUsdInput(form.weeklyUsd || "0", true);
  const m = normalizeUsdInput(form.monthlyUsd || "0", true);
  if (!d || !w || !m) {
    saveError.value = t("userLimits.quotas.invalidAmount");
    return;
  }
  saving.value = true;
  try {
    const res = await apiJson<UserPlatformQuotasResponse>(
      `/api/v1/admin/users/${encodeURIComponent(props.user.id)}/platform-quotas`,
      {
        method: "PUT",
        body: {
          items: [
            {
              platform: form.platform,
              dailyLimitNanoUsd: parseUsdToNano(d).toString(),
              weeklyLimitNanoUsd: parseUsdToNano(w).toString(),
              monthlyLimitNanoUsd: parseUsdToNano(m).toString(),
            },
          ],
        },
      },
    );
    items.value = res.items;
    toast.success(t("userLimits.quotas.saved"));
    emit("saved");
  } catch (err) {
    saveError.value = errorOf(err, t("userLimits.quotas.saveFailed"));
  } finally {
    saving.value = false;
  }
}

async function resetWindow(platform: string, win: QuotaResetWindow) {
  if (busyPlatform.value) return;
  busyPlatform.value = platform;
  try {
    await apiJson(
      `/api/v1/admin/users/${encodeURIComponent(props.user.id)}/platform-quotas/${encodeURIComponent(platform)}/reset`,
      { method: "POST", body: { window: win } },
    );
    toast.success(t("userLimits.quotas.resetDone", { platform, window: t(`userLimits.quotas.windows.${win}`) }));
    await load();
    emit("saved");
  } catch (err) {
    toast.error(errorOf(err, t("userLimits.quotas.resetFailed")));
  } finally {
    busyPlatform.value = null;
  }
}

async function removeQuota(platform: string) {
  if (busyPlatform.value) return;
  busyPlatform.value = platform;
  try {
    await apiJson(
      `/api/v1/admin/users/${encodeURIComponent(props.user.id)}/platform-quotas/${encodeURIComponent(platform)}`,
      { method: "DELETE" },
    );
    toast.success(t("userLimits.quotas.deleted", { platform }));
    await load();
    emit("saved");
  } catch (err) {
    toast.error(errorOf(err, t("userLimits.quotas.deleteFailed")));
  } finally {
    busyPlatform.value = null;
  }
}

function windowRows(item: UserPlatformQuotaItem) {
  return (
    [
      { key: "daily" as const, limit: item.dailyLimitNanoUsd, used: item.dailyUsedNanoUsd },
      { key: "weekly" as const, limit: item.weeklyLimitNanoUsd, used: item.weeklyUsedNanoUsd },
      { key: "monthly" as const, limit: item.monthlyLimitNanoUsd, used: item.monthlyUsedNanoUsd },
    ] as const
  )
    .filter((w) => BigInt(w.limit) > 0n)
    .map((w) => {
      const cap = BigInt(w.limit);
      const used = BigInt(w.used);
      const pct = cap > 0n ? Math.min(100, Number((used * 1000n) / cap) / 10) : 0;
      const breached = used >= cap;
      return { ...w, pct, breached };
    });
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs leading-relaxed text-fg-subtle">{{ t("userLimits.quotas.intro") }}</p>

    <UiAlert v-if="loadError" tone="danger">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs" @click="load">{{ t("userLimits.common.retry") }}</button>
      </template>
    </UiAlert>

    <UiAlert v-if="saveError" tone="danger">{{ saveError }}</UiAlert>

    <!-- Upsert form -->
    <form class="rounded-lg border border-line bg-surface-2/40 p-3.5 space-y-3" @submit.prevent="saveQuota">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">{{ t("userLimits.quotas.platform") }}</label>
          <select v-model="form.platform" class="select input-sm">
            <option v-for="p in platformOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div>
          <label class="label">{{ t("userLimits.quotas.daily") }}</label>
          <input v-model="form.dailyUsd" type="text" inputmode="decimal" class="input input-sm font-mono" placeholder="0" />
        </div>
        <div>
          <label class="label">{{ t("userLimits.quotas.weekly") }}</label>
          <input v-model="form.weeklyUsd" type="text" inputmode="decimal" class="input input-sm font-mono" placeholder="0" />
        </div>
        <div>
          <label class="label">{{ t("userLimits.quotas.monthly") }}</label>
          <input v-model="form.monthlyUsd" type="text" inputmode="decimal" class="input input-sm font-mono" placeholder="0" />
        </div>
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-2xs text-fg-subtle">{{ t("userLimits.quotas.zeroHint") }}</span>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="saving || !formValid">
          <UiIcon :name="saving ? 'loader' : 'check'" :size="13" :spin="saving" />
          {{ t("userLimits.quotas.save") }}
        </button>
      </div>
    </form>

    <!-- Configured platform quotas -->
    <div v-if="loading && !loaded" class="space-y-2" aria-busy="true">
      <div v-for="i in 2" :key="i" class="h-20 animate-pulse rounded-lg bg-surface-2/60" />
    </div>

    <EmptyState
      v-else-if="loaded && items.length === 0"
      compact
      icon="gauge"
      :title="t('userLimits.quotas.empty')"
    />

    <div v-else class="space-y-2.5">
      <div
        v-for="item in items"
        :key="item.platform"
        class="rounded-lg border border-line bg-surface p-3.5 space-y-2.5"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <PlatformIcon :platform="item.platform" :size="15" />
            <span class="text-sm font-medium text-fg">{{ item.platform }}</span>
            <UiBadge :tone="item.overLimit ? 'danger' : 'success'" dot>
              {{ item.overLimit ? t("userLimits.quotas.overLimit") : t("userLimits.quotas.ok") }}
            </UiBadge>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs"
              :title="t('common.edit')"
              @click="editItem(item)"
            >
              <UiIcon name="pencil" :size="13" />
            </button>
            <ConfirmButton
              icon-only
              :disabled="busyPlatform === item.platform"
              @confirm="removeQuota(item.platform)"
            />
          </div>
        </div>

        <div class="space-y-1.5">
          <div v-for="w in windowRows(item)" :key="w.key">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="text-fg-subtle">{{ t(`userLimits.quotas.windows.${w.key}`) }}</span>
              <div class="flex items-center gap-2">
                <span class="font-mono tabular-nums" :class="w.breached ? 'text-danger font-medium' : 'text-fg-muted'">
                  {{ formatUsd(w.used) }} / {{ formatUsd(w.limit) }}
                </span>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs text-2xs"
                  :disabled="busyPlatform === item.platform"
                  @click="resetWindow(item.platform, w.key)"
                >
                  <UiIcon name="rotate-ccw" :size="11" />
                  {{ t("userLimits.quotas.resetWindow") }}
                </button>
              </div>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                class="h-full rounded-full transition-[width] duration-300"
                :class="w.breached ? 'bg-danger' : w.pct >= 80 ? 'bg-warning' : 'bg-success'"
                :style="{ width: `${Math.min(100, Math.max(w.pct > 0 ? 2 : 0, w.pct))}%` }"
              />
            </div>
          </div>
        </div>

        <div class="flex justify-end">
          <button
            type="button"
            class="btn btn-secondary btn-xs"
            :disabled="busyPlatform === item.platform"
            @click="resetWindow(item.platform, 'all')"
          >
            <UiIcon name="rotate-ccw" :size="12" />
            {{ t("userLimits.quotas.resetAll") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
