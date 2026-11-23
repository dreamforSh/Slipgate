<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PromoCodeItem, PromoCodeUsageItem } from "@slipgate/contracts";
import EmptyState from "../../ui/EmptyState.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatRelative, formatUsd } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ListSkeleton from "./ListSkeleton.vue";
import { STAGGER_CLASS, stagger } from "./opsUtil";

/** Who signed up with a promo code, and when. */
const props = defineProps<{ open: boolean; item: PromoCodeItem | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const toast = useToastStore();

const usages = ref<PromoCodeUsageItem[]>([]);
const loading = ref(false);
let seq = 0;

watch(
  () => [props.open, props.item?.id] as const,
  async ([open, id]) => {
    if (!open || !id) return;
    const mine = ++seq;
    usages.value = [];
    loading.value = true;
    try {
      const res = await apiJson<{ items: PromoCodeUsageItem[] }>(`/api/v1/admin/promo-codes/${encodeURIComponent(id)}/usages`);
      if (mine === seq) usages.value = res.items;
    } catch (err) {
      if (mine === seq) toast.error(errorText(err, t("promo.errors.usages")));
    } finally {
      if (mine === seq) loading.value = false;
    }
  },
  { immediate: true },
);

const totalBonus = computed(() => usages.value.reduce((sum, u) => sum + BigInt(u.bonusNanoUsd), 0n).toString());
</script>

<template>
  <UiDrawer :open="open" width="lg" :title="t('promo.usages.title')" @update:open="emit('update:open', $event)">
    <div v-if="item" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/40 px-4 py-3">
        <div class="min-w-0">
          <p class="text-xs text-fg-subtle">{{ t("promo.table.code") }}</p>
          <p class="mt-0.5 truncate font-mono text-base font-semibold tracking-wider text-fg">{{ item.code }}</p>
        </div>
        <div class="text-right text-xs">
          <p class="font-semibold text-fg">{{ t("promo.usages.total", { n: usages.length }) }}</p>
          <p class="mt-0.5 text-success">{{ t("promo.usages.totalBonus", { amount: formatUsd(totalBonus) }) }}</p>
        </div>
      </div>

      <div class="overflow-hidden rounded-xl border border-line">
        <ListSkeleton v-if="loading" :rows="4" dense />
        <EmptyState v-else-if="usages.length === 0" icon="users" :title="t('promo.usages.empty')" compact />
        <ul v-else class="divide-y divide-line/60">
          <li
            v-for="(u, i) in usages"
            :key="`${u.userId}-${u.usedAtIso}`"
            class="flex items-center gap-3 px-4 py-3"
            :class="STAGGER_CLASS"
            :style="stagger(i)"
          >
            <span class="icon-chip icon-chip-accent h-8 w-8 text-xs font-semibold uppercase">
              {{ u.userEmail.slice(0, 1) || "?" }}
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-fg" :title="u.userEmail">{{ u.userEmail }}</p>
              <p class="mt-0.5 text-2xs text-fg-subtle" :title="formatRelative(u.usedAtIso)">
                <UiIcon name="clock" :size="11" class="mr-0.5 inline -translate-y-px" />
                {{ formatDateTime(u.usedAtIso) }}
              </p>
            </div>
            <span class="font-mono text-xs font-semibold tabular-nums text-success">+{{ formatUsd(u.bonusNanoUsd) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </UiDrawer>
</template>
