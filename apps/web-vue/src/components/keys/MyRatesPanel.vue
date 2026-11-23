<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { UserGroupRateItem, UserGroupRatesResponse } from "@slipgate/contracts";
import { usePersistentState } from "../../composables/usePersistentState";
import { platformShortLabel, platformStyle } from "../../lib/platformStyle";
import PlatformIcon from "../ui/PlatformIcon.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";

/**
 * What the signed-in user pays and may send per group: their effective multiplier (an admin's
 * custom rate, else the group's), the group's per-user caps and the user's own account caps.
 */
const props = defineProps<{ data: UserGroupRatesResponse | null; loading: boolean; error: string | null }>();
const emit = defineEmits<{ (e: "retry"): void }>();

const { t } = useI18n();

const expanded = usePersistentState<boolean>("slipgate.keys.ratesExpanded", false, (v): v is boolean => typeof v === "boolean");

const items = computed(() =>
  [...(props.data?.items ?? [])].sort(
    (a, b) =>
      Number(b.customRateMultiplier !== null) - Number(a.customRateMultiplier !== null) ||
      a.effectiveRateMultiplier - b.effectiveRateMultiplier ||
      a.groupName.localeCompare(b.groupName),
  ),
);
const customCount = computed(() => items.value.filter((i) => i.customRateMultiplier !== null).length);

const fmt = (n: number) => Number(n.toFixed(4));
function cap(value: number, kind: "rpm" | "concurrency"): string {
  if (value <= 0) return t("userLimits.cap.unlimited");
  return kind === "rpm" ? t("userLimits.cap.rpm", { n: value }) : t("userLimits.cap.concurrency", { n: value });
}
function tone(i: UserGroupRateItem): string {
  if (i.effectiveRateMultiplier < i.groupRateMultiplier) return "text-success";
  if (i.effectiveRateMultiplier > i.groupRateMultiplier) return "text-warning";
  return "text-fg";
}
</script>

<template>
  <UiCard icon="percent" :title="t('userLimits.mine.title')">
    <template #actions>
      <span v-if="data" class="hidden items-center gap-1.5 text-xs text-fg-subtle sm:inline-flex">
        <UiIcon name="gauge" :size="12" />{{ cap(data.userRpmLimit, "rpm") }}
        <span class="text-line-strong">·</span>
        <UiIcon name="activity" :size="12" />{{ cap(data.userConcurrencyLimit, "concurrency") }}
      </span>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :aria-expanded="expanded"
        aria-controls="my-rates-body"
        :disabled="!data"
        @click="expanded = !expanded"
      >
        {{ expanded ? t("userLimits.mine.collapse") : t("userLimits.mine.expand") }}
        <UiIcon name="chevron-down" :size="13" class="transition-transform duration-200 motion-reduce:transition-none" :class="expanded ? 'rotate-180' : ''" />
      </button>
    </template>

    <UiAlert v-if="error && !data" tone="danger">
      {{ error }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs" @click="emit('retry')">{{ t("userLimits.common.retry") }}</button>
      </template>
    </UiAlert>

    <div v-else-if="!data" class="flex flex-wrap gap-3" aria-busy="true">
      <span v-for="i in 3" :key="i" class="h-14 w-48 rounded-lg bg-surface-2 motion-safe:animate-pulse" />
    </div>

    <template v-else>
      <!-- Summary (always shown) -->
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-line/70 bg-surface-2/40 px-3.5 py-2.5">
          <p class="text-2xs text-fg-subtle">{{ t("userLimits.mine.accountRpm") }}</p>
          <p class="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">{{ cap(data.userRpmLimit, "rpm") }}</p>
        </div>
        <div class="rounded-lg border border-line/70 bg-surface-2/40 px-3.5 py-2.5">
          <p class="text-2xs text-fg-subtle">{{ t("userLimits.mine.accountConcurrency") }}</p>
          <p class="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">{{ cap(data.userConcurrencyLimit, "concurrency") }}</p>
        </div>
        <div class="rounded-lg border px-3.5 py-2.5" :class="customCount ? 'border-success/25 bg-success/[0.06]' : 'border-line/70 bg-surface-2/40'">
          <p class="text-2xs text-fg-subtle">{{ t("userLimits.mine.customRates") }}</p>
          <p class="mt-0.5 text-sm font-semibold" :class="customCount ? 'text-success' : 'text-fg'">
            {{ customCount ? t("userLimits.mine.customCount", { n: customCount }) : t("userLimits.mine.noCustom") }}
          </p>
        </div>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="-translate-y-1 opacity-0"
      >
        <div v-if="expanded" id="my-rates-body" class="mt-4">
          <p v-if="items.length === 0" class="rounded-lg border border-dashed border-line px-3.5 py-4 text-center text-xs text-fg-subtle">
            {{ t("userLimits.mine.empty") }}
          </p>
          <ul v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <li
              v-for="(i, idx) in items"
              :key="i.groupId"
              class="animate-slide-up rounded-lg border border-line/70 bg-surface px-3.5 py-3 [animation-fill-mode:backwards] motion-reduce:animate-none dark:bg-surface-2/30"
              :style="{ animationDelay: `${Math.min(idx, 10) * 24}ms` }"
            >
              <div class="flex items-start gap-2.5">
                <span class="icon-chip h-8 w-8" :class="platformStyle(i.platform).badge"><PlatformIcon :platform="i.platform" :size="15" /></span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-fg" :title="i.groupName">{{ i.groupName }}</p>
                  <p class="text-2xs text-fg-subtle">{{ platformShortLabel(i.platform) }}</p>
                </div>
                <div class="shrink-0 text-right">
                  <p class="font-mono text-base font-semibold tabular-nums" :class="tone(i)">×{{ fmt(i.effectiveRateMultiplier) }}</p>
                  <p v-if="i.customRateMultiplier !== null" class="text-2xs text-fg-subtle">
                    <span class="line-through">×{{ fmt(i.groupRateMultiplier) }}</span>
                    <span
                      class="ml-1 rounded-full px-1.5 font-medium"
                      :class="i.effectiveRateMultiplier < i.groupRateMultiplier ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'"
                    >
                      {{ t("userLimits.mine.custom") }}
                    </span>
                  </p>
                </div>
              </div>
              <p class="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-line/60 pt-2 text-2xs text-fg-subtle">
                <span class="inline-flex items-center gap-1"><UiIcon name="gauge" :size="11" />{{ i.rpmLimit > 0 ? cap(i.rpmLimit, "rpm") : t("userLimits.mine.noGroupCap") }}</span>
                <span class="inline-flex items-center gap-1">
                  <UiIcon name="activity" :size="11" />{{ i.concurrencyLimit > 0 ? cap(i.concurrencyLimit, "concurrency") : t("userLimits.mine.noGroupCap") }}
                </span>
              </p>
            </li>
          </ul>
          <p class="mt-3 flex items-start gap-1.5 text-2xs leading-4 text-fg-subtle">
            <UiIcon name="info" :size="12" class="mt-px shrink-0" />{{ t("userLimits.mine.note") }}
          </p>
        </div>
      </Transition>
    </template>
  </UiCard>
</template>
