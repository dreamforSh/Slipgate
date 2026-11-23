<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { UserSubscriptionItem } from "@slipgate/contracts";
import SubscriptionCard from "../../components/me/SubscriptionCard.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText } from "../../lib/api";

const { t } = useI18n();
const now = useNow(60_000);

const items = ref<UserSubscriptionItem[]>([]);
const loaded = ref(false);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const res = await apiJson<{ items: UserSubscriptionItem[] }>("/api/v1/user/subscriptions");
    items.value = res.items;
    loaded.value = true;
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("mySubs.loadFailed"));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** Active rows whose end date passed are shown as expired, like the server reports them. */
function isLive(s: UserSubscriptionItem): boolean {
  return s.status === "active" && Date.parse(s.expiresAtIso) > now.value;
}

const sorted = computed(() =>
  [...items.value].sort((a, b) => {
    const la = isLive(a);
    const lb = isLive(b);
    if (la !== lb) return la ? -1 : 1;
    // Live: soonest to expire first. Ended: most recent first.
    return la ? Date.parse(a.expiresAtIso) - Date.parse(b.expiresAtIso) : Date.parse(b.expiresAtIso) - Date.parse(a.expiresAtIso);
  }),
);

type Filter = "all" | "active" | "ended";
const filter = ref<Filter>("all");
const liveCount = computed(() => items.value.filter(isLive).length);
const filterOptions = computed(() => [
  { value: "all" as const, label: t("mySubs.filter.all"), count: items.value.length },
  { value: "active" as const, label: t("mySubs.filter.active"), count: liveCount.value },
  { value: "ended" as const, label: t("mySubs.filter.ended"), count: items.value.length - liveCount.value },
]);
const visible = computed(() =>
  sorted.value.filter((s) => (filter.value === "all" ? true : filter.value === "active" ? isLive(s) : !isLive(s))),
);
const limitedCount = computed(() => items.value.filter((s) => isLive(s) && s.overLimit).length);

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 55}ms`, animationFillMode: "both" });
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('mySubs.title')">
      <template #meta>
        <UiBadge v-if="loaded && liveCount" tone="success" dot>{{ t("mySubs.liveCount", { n: liveCount }) }}</UiBadge>
      </template>
      <template #actions>
        <RouterLink to="/redeem" class="btn btn-secondary">
          <UiIcon name="ticket" :size="15" />
          {{ t("mySubs.redeem") }}
        </RouterLink>
        <button
          type="button"
          class="btn btn-secondary btn-icon"
          :disabled="loading"
          :title="t('common.refresh')"
          :aria-label="t('common.refresh')"
          @click="load"
        >
          <UiIcon name="refresh" :size="15" :spin="loading" />
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="loadError && !loaded" tone="warning">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("mySubs.retry") }}
        </button>
      </template>
    </UiAlert>

    <!-- Skeleton -->
    <div v-if="!loaded && loading" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      <div v-for="i in 3" :key="i" class="card space-y-4 p-5">
        <div class="flex items-center gap-3">
          <div class="h-10 w-10 animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />
          <div class="flex-1 space-y-2">
            <div class="h-3.5 w-32 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <div class="h-2.5 w-20 animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
          </div>
        </div>
        <div class="h-8 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
        <div v-for="j in 2" :key="j" class="space-y-1.5">
          <div class="h-2.5 w-full animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
          <div class="h-2 w-full animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none" />
        </div>
      </div>
    </div>

    <!-- Empty -->
    <section v-else-if="loaded && !items.length" class="card animate-slide-up motion-reduce:animate-none">
      <EmptyState icon="crown" :title="t('mySubs.empty.title')">
        <div class="w-full">
          <p class="mx-auto -mt-2 mb-5 max-w-sm text-sm text-fg-subtle">{{ t("mySubs.empty.body") }}</p>
          <RouterLink to="/redeem" class="btn btn-primary">
            <UiIcon name="ticket" :size="15" />
            {{ t("mySubs.empty.action") }}
          </RouterLink>
        </div>
      </EmptyState>
    </section>

    <template v-else-if="loaded">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl v-model="filter" :options="filterOptions" />
        <p v-if="limitedCount" class="flex items-center gap-1.5 text-xs text-warning">
          <UiIcon name="alert" :size="13" />
          {{ t("mySubs.limitedSummary", { n: limitedCount }) }}
        </p>
      </div>

      <TransitionGroup
        v-if="visible.length"
        tag="div"
        class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        move-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-active-class="hidden"
      >
        <SubscriptionCard
          v-for="(item, i) in visible"
          :key="item.id"
          :item="item"
          :now="now"
          :grow-delay-ms="Math.min(i, 8) * 55 + 160"
          class="animate-slide-up motion-reduce:animate-none"
          :style="stagger(i)"
        />
      </TransitionGroup>
      <div v-else class="card">
        <EmptyState compact icon="filter" :title="t('mySubs.filter.empty')" />
      </div>
    </template>
  </div>
</template>
