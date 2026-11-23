<script setup lang="ts">
import { ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { AdminGroupApiKeysResponse, AdminGroupApiKeyItem, GroupItem } from "@slipgate/contracts";
import { useNow } from "../../../composables/useNow";
import { apiJson, toQuery } from "../../../lib/api";
import { formatDateTime, formatRelative, formatUsd } from "../../../lib/format";
import EmptyState from "../../ui/EmptyState.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiPagination from "../../ui/UiPagination.vue";
import { useLimitText } from "../users/limits";
import { staggerStyle } from "../users/userDisplay";

/** Every API key bound to one group, with its owner (GET /admin/groups/:groupId/api-keys). */
const props = defineProps<{ group: GroupItem | null }>();
const open = defineModel<boolean>("open", { required: true });

const { t, errorOf } = useLimitText();
const now = useNow(30_000);

const items = ref<AdminGroupApiKeyItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);

let seq = 0;
async function load() {
  const g = props.group;
  if (!g) return;
  const id = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const res = await apiJson<AdminGroupApiKeysResponse>(
      `/api/v1/admin/groups/${encodeURIComponent(g.id)}/api-keys${toQuery({ page: page.value, pageSize: pageSize.value })}`,
    );
    if (id !== seq) return;
    items.value = res.items;
    total.value = res.total;
    loaded.value = true;
  } catch (err) {
    if (id === seq) error.value = errorOf(err, t("userLimits.groupKeys.loadFailed"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  page.value = 1;
  loaded.value = false;
  items.value = [];
  total.value = 0;
  void load();
});
watch([page, pageSize], () => {
  if (open.value) void load();
});

function expired(k: AdminGroupApiKeyItem): boolean {
  return Boolean(k.expiresAtIso && Date.parse(k.expiresAtIso) <= now.value);
}
</script>

<template>
  <UiDrawer v-model:open="open" width="lg" :title="t('userLimits.groupKeys.title', { name: group?.name ?? '' })">
    <div class="mb-4 flex items-center justify-between gap-2">
      <p class="text-xs text-fg-subtle">
        <template v-if="loaded">{{ t("userLimits.groupKeys.count", { n: total }) }}</template>
      </p>
      <button
        type="button"
        class="btn btn-ghost btn-icon btn-sm"
        :disabled="loading"
        :title="t('common.refresh')"
        :aria-label="t('common.refresh')"
        @click="load"
      >
        <UiIcon name="refresh" :size="14" :spin="loading" />
      </button>
    </div>

    <UiAlert v-if="error" tone="danger" class="mb-4">
      {{ error }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs" @click="load">{{ t("userLimits.common.retry") }}</button>
      </template>
    </UiAlert>

    <div v-if="!loaded && loading" class="space-y-2" aria-busy="true">
      <div v-for="i in 4" :key="i" class="rounded-lg border border-line/60 p-3.5 motion-safe:animate-pulse">
        <span class="block h-3.5 w-1/3 rounded bg-surface-2" />
        <span class="mt-2 block h-2.5 w-2/3 rounded bg-surface-2" />
      </div>
    </div>

    <EmptyState v-else-if="loaded && items.length === 0" icon="key" compact :title="t('userLimits.groupKeys.empty')" />

    <ul v-else class="space-y-2 transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
      <li
        v-for="(k, i) in items"
        :key="k.id"
        class="animate-slide-up rounded-lg border border-line/60 bg-surface px-3.5 py-3 [animation-fill-mode:backwards] motion-reduce:animate-none dark:bg-surface-2/30"
        :class="k.enabled && !expired(k) ? '' : 'opacity-70'"
        :style="staggerStyle(i)"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="icon-chip icon-chip-accent h-7 w-7"><UiIcon name="key" :size="13" /></span>
          <p class="min-w-0 flex-1 truncate text-sm font-medium text-fg" :title="k.name">{{ k.name }}</p>
          <UiBadge v-if="expired(k)" tone="danger" dot>{{ t("adminUsers.apiKeys.expired") }}</UiBadge>
          <UiBadge v-else :tone="k.enabled ? 'success' : 'neutral'" dot>{{ k.enabled ? t("common.enabled") : t("common.disabled") }}</UiBadge>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-9 text-xs text-fg-muted">
          <RouterLink
            :to="{ path: '/admin/users', query: { search: k.userEmail } }"
            class="inline-flex min-w-0 max-w-full items-center gap-1 truncate rounded-md text-accent transition-colors hover:underline"
            :title="t('userLimits.groupKeys.owner')"
            @click="open = false"
          >
            <UiIcon name="user" :size="12" />
            <span class="truncate">{{ k.userEmail }}</span>
          </RouterLink>
          <span class="code-chip">{{ k.keyPrefix }}…</span>
          <span class="font-mono tabular-nums">{{ t("adminUsers.apiKeys.limits", { rpm: k.rpmLimit, concurrency: k.concurrencyLimit }) }}</span>
        </div>
        <div class="mt-1.5 flex flex-wrap items-center justify-between gap-2 pl-9 text-2xs text-fg-subtle">
          <span class="font-mono tabular-nums">
            {{
              k.quotaNanoUsd === "0"
                ? t("userLimits.groupKeys.spent", { amount: formatUsd(k.spentNanoUsd) })
                : t("userLimits.groupKeys.spentOf", { amount: formatUsd(k.spentNanoUsd), quota: formatUsd(k.quotaNanoUsd) })
            }}
          </span>
          <span :title="formatDateTime(k.lastUsedAtIso)">
            {{ k.lastUsedAtIso ? t("userLimits.keys.lastUsed", { time: formatRelative(k.lastUsedAtIso, now) }) : t("userLimits.keys.neverUsed") }}
          </span>
        </div>
      </li>
    </ul>

    <template v-if="loaded && total > 20" #footer>
      <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" :disabled="loading" class="w-full border-t-0 !px-0 !py-0" />
    </template>
  </UiDrawer>
</template>
