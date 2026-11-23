<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { AdminUpdateApiKeyRequest, AdminUpdateApiKeyResponse, AdminUserItem, ApiKeyItem, GroupItem } from "@slipgate/contracts";
import { useNow } from "../../../composables/useNow";
import { apiJson } from "../../../lib/api";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import KeyFlags from "../../keys/KeyFlags.vue";
import KeyUsageCell from "../../keys/KeyUsageCell.vue";
import { WINDOWS, isZeroNano, windowOf } from "../../keys/keyLimits";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { staggerStyle } from "./userDisplay";
import { fmtRate, useLimitText } from "./limits";

/**
 * Any user's API keys with admin actions (Linksyncx UserApiKeysModal): rebind the group (an
 * exclusive target is granted to the owner automatically), enable / disable, and reset the
 * rolling windows or the lifetime quota. All through PATCH /admin/api-keys/:keyId.
 */
const props = defineProps<{ user: AdminUserItem; groups: GroupItem[]; active: boolean }>();
const emit = defineEmits<{
  (e: "changed"): void;
  /** The owner was granted an exclusive group by a move. */
  (e: "granted", groupId: string): void;
  (e: "replace", keys: ApiKeyItem[]): void;
  (e: "loaded", keys: ApiKeyItem[]): void;
  (e: "navigate"): void;
}>();

const { t, errorOf } = useLimitText();
const toast = useToastStore();
const now = useNow(30_000);

const items = ref<ApiKeyItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const busy = ref(new Set<string>());

let seq = 0;
async function load() {
  const id = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await apiJson<{ items: ApiKeyItem[] }>(`/api/v1/admin/users/${encodeURIComponent(props.user.id)}/api-keys`);
    if (id !== seq) return;
    items.value = res.items;
    loaded.value = true;
    emit("loaded", res.items);
  } catch (err) {
    if (id === seq) loadError.value = errorOf(err, t("adminUsers.errors.apiKeys"));
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

defineExpose({ reload: load });

/* ---------------- Groups ---------------- */

const granted = computed(() => new Set(props.user.allowedGroupIds));
const groupById = computed(() => new Map(props.groups.map((g) => [g.id, g])));
const selectable = computed(() =>
  props.groups.filter((g) => g.enabled).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
);

function optionLabel(g: GroupItem): string {
  const base = `${g.name} · ${g.platform}${g.rateMultiplier !== 1 ? ` · ×${fmtRate(g.rateMultiplier)}` : ""}`;
  if (g.isExclusive && !granted.value.has(g.id) && props.user.role !== "admin") return `${base} · ${t("userLimits.keys.willGrant")}`;
  return base;
}

/* ---------------- Actions ---------------- */

function setBusy(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

async function patch(k: ApiKeyItem, body: AdminUpdateApiKeyRequest, action: string): Promise<AdminUpdateApiKeyResponse | null> {
  setBusy(k.id, true);
  try {
    const res = await apiJson<AdminUpdateApiKeyResponse>(`/api/v1/admin/api-keys/${encodeURIComponent(k.id)}`, {
      method: "PATCH",
      body,
    });
    items.value = items.value.map((x) => (x.id === k.id ? res.item : x));
    emit("changed");
    return res;
  } catch (err) {
    toast.error(errorOf(err, action));
    return null;
  } finally {
    setBusy(k.id, false);
  }
}

async function changeGroup(k: ApiKeyItem, ev: Event) {
  const el = ev.target as HTMLSelectElement;
  const next = el.value;
  el.value = k.groupId; // snap back until the server confirms
  if (!next || next === k.groupId) return;
  const res = await patch(k, { groupId: next }, t("userLimits.keys.groupFailed"));
  if (!res) return;
  const name = res.item.groupName || groupById.value.get(next)?.name || next;
  if (res.autoGrantedGroupAccess && res.grantedGroupId) {
    toast.info(t("userLimits.keys.groupGranted", { key: res.item.name, group: name }));
    emit("granted", res.grantedGroupId);
  } else {
    toast.success(t("userLimits.keys.groupChanged", { key: res.item.name, group: name }));
  }
}

async function toggle(k: ApiKeyItem) {
  const res = await patch(k, { enabled: !k.enabled }, t("userLimits.keys.toggleFailed"));
  if (res) toast.success(res.item.enabled ? t("userLimits.keys.enabled", { key: k.name }) : t("userLimits.keys.disabled", { key: k.name }));
}

async function resetWindows(k: ApiKeyItem) {
  const res = await patch(k, { resetWindows: true }, t("userLimits.keys.resetFailed"));
  if (res) toast.success(t("userLimits.keys.windowsReset", { key: k.name }));
}

async function resetQuota(k: ApiKeyItem) {
  const res = await patch(k, { resetQuota: true }, t("userLimits.keys.resetFailed"));
  if (res) toast.success(t("userLimits.keys.quotaReset", { key: k.name }));
}

const windowsZero = (k: ApiKeyItem) => WINDOWS.every((w) => isZeroNano(windowOf(k, w).used));
const enabledCount = computed(() => items.value.filter((k) => k.enabled).length);
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-xs text-fg-subtle">
        <template v-if="loaded">{{ t("userLimits.keys.summary", { n: items.length, enabled: enabledCount }) }}</template>
      </p>
      <div class="ml-auto flex flex-wrap items-center gap-1.5">
        <button type="button" class="btn btn-secondary btn-sm" :disabled="!loaded" @click="emit('replace', items)">
          <UiIcon name="migrate" :size="13" />
          {{ t("userLimits.keys.replace") }}
        </button>
        <RouterLink
          :to="{ path: '/admin/usage', query: { userId: user.id } }"
          class="btn btn-ghost btn-sm"
          @click="emit('navigate')"
        >
          <UiIcon name="chart" :size="13" />
          {{ t("adminUsers.actions.viewUsage") }}
        </RouterLink>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          :disabled="loading"
          :title="t('common.refresh')"
          :aria-label="t('common.refresh')"
          @click="load"
        >
          <UiIcon name="refresh" :size="13" :spin="loading" />
        </button>
      </div>
    </div>

    <UiAlert v-if="loadError && !loaded" tone="danger">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs" @click="load">{{ t("userLimits.common.retry") }}</button>
      </template>
    </UiAlert>

    <div v-else-if="!loaded" class="space-y-2" aria-busy="true">
      <div v-for="i in 3" :key="i" class="rounded-lg border border-line/60 p-3.5 motion-safe:animate-pulse">
        <span class="block h-3.5 w-1/3 rounded bg-surface-2" />
        <span class="mt-2 block h-2.5 w-2/3 rounded bg-surface-2" />
        <span class="mt-3 block h-1.5 w-full rounded-full bg-surface-2/70" />
      </div>
    </div>

    <EmptyState v-else-if="items.length === 0" icon="key" compact :title="t('adminUsers.apiKeys.empty')" />

    <TransitionGroup v-else tag="ul" class="space-y-2" move-class="transition-transform duration-200 ease-out motion-reduce:transition-none">
      <li
        v-for="(k, i) in items"
        :key="k.id"
        class="animate-slide-up rounded-lg border border-line/70 bg-surface px-3.5 py-3 transition-opacity duration-200 [animation-fill-mode:backwards] motion-reduce:animate-none dark:bg-surface-2/30"
        :class="busy.has(k.id) ? 'opacity-70' : ''"
        :style="staggerStyle(i)"
        :aria-busy="busy.has(k.id) || undefined"
      >
        <div class="flex items-start gap-2.5">
          <span class="icon-chip icon-chip-accent mt-0.5 h-7 w-7"><UiIcon name="key" :size="13" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-fg" :title="k.name">{{ k.name }}</p>
            <div class="mt-1 flex flex-wrap items-center gap-1.5">
              <span class="code-chip">{{ k.keyPrefix }}…</span>
              <KeyFlags :item="k" :now="now" />
            </div>
          </div>
          <UiSwitch
            :model-value="k.enabled"
            :disabled="busy.has(k.id)"
            :label="k.enabled ? t('common.enabled') : t('common.disabled')"
            @update:model-value="toggle(k)"
          />
        </div>

        <div class="mt-3 grid gap-3 sm:grid-cols-2 sm:items-end">
          <label class="min-w-0">
            <span class="mb-1 block text-2xs text-fg-subtle">{{ t("userLimits.keys.group") }}</span>
            <span class="relative block">
              <select
                :value="k.groupId"
                :disabled="busy.has(k.id)"
                class="select input-sm"
                :aria-label="t('userLimits.keys.groupFor', { key: k.name })"
                @change="changeGroup(k, $event)"
              >
                <option v-if="!groupById.get(k.groupId)?.enabled" :value="k.groupId" disabled>
                  {{ t("userLimits.keys.currentUnavailable", { name: k.groupName }) }}
                </option>
                <option v-for="g in selectable" :key="g.id" :value="g.id">{{ optionLabel(g) }}</option>
              </select>
            </span>
          </label>
          <KeyUsageCell :item="k" />
        </div>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2.5">
          <p class="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-subtle">
            <span class="font-mono tabular-nums">{{ t("adminUsers.apiKeys.limits", { rpm: k.rpmLimit, concurrency: k.concurrencyLimit }) }}</span>
            <span :title="formatDateTime(k.lastUsedAtIso)">
              {{ k.lastUsedAtIso ? t("userLimits.keys.lastUsed", { time: formatRelative(k.lastUsedAtIso, now) }) : t("userLimits.keys.neverUsed") }}
            </span>
          </p>
          <div class="flex flex-wrap items-center gap-1">
            <ConfirmButton
              icon="rotate-ccw"
              :label="t('userLimits.keys.resetWindows')"
              :confirm-label="t('userLimits.keys.resetConfirm')"
              :disabled="busy.has(k.id) || windowsZero(k)"
              @confirm="resetWindows(k)"
            />
            <ConfirmButton
              icon="rotate-ccw"
              :label="t('userLimits.keys.resetQuota')"
              :confirm-label="t('userLimits.keys.resetConfirm')"
              :disabled="busy.has(k.id) || isZeroNano(k.spentNanoUsd)"
              @confirm="resetQuota(k)"
            />
          </div>
        </div>
      </li>
    </TransitionGroup>
  </div>
</template>
