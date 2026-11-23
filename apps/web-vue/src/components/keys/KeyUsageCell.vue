<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem } from "@slipgate/contracts";
import LimitBar from "./LimitBar.vue";
import { WINDOWS, isZeroNano, windowOf } from "./keyLimits";

/** Lifetime quota bar plus one bar per capped rolling window (5h / 1d / 7d). */
const props = defineProps<{ item: ApiKeyItem }>();

const { t } = useI18n();

const windows = computed(() =>
  WINDOWS.map((w) => ({ key: w, ...windowOf(props.item, w) })).filter((w) => !isZeroNano(w.limit)),
);
</script>

<template>
  <div class="space-y-1.5">
    <LimitBar :label="t('user.keys.quota')" :used="item.spentNanoUsd" :limit="item.quotaNanoUsd" compact />
    <div v-if="windows.length" class="grid gap-1.5">
      <LimitBar
        v-for="w in windows"
        :key="w.key"
        :label="t(`user.keys.windows.${w.key}`)"
        :used="w.used"
        :limit="w.limit"
        compact
      />
    </div>
  </div>
</template>
