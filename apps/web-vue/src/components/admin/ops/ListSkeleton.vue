<script setup lang="ts">
import { useI18n } from "vue-i18n";

/** Shimmering placeholder rows shown while a list loads for the first time. */
withDefaults(defineProps<{ rows?: number; dense?: boolean }>(), { rows: 6, dense: false });

const { t } = useI18n();
const widths = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3", "w-1/4"];
</script>

<template>
  <div class="divide-y divide-line/60" aria-busy="true" role="status">
    <div
      v-for="i in rows"
      :key="i"
      class="flex items-center gap-4 px-5 motion-safe:animate-pulse"
      :class="dense ? 'py-2.5' : 'py-3.5'"
      :style="{ animationDelay: `${(i - 1) * 90}ms` }"
    >
      <span class="h-8 w-8 shrink-0 rounded-lg bg-surface-2" />
      <div class="min-w-0 flex-1 space-y-2">
        <span class="block h-2.5 rounded-full bg-surface-2" :class="widths[(i - 1) % widths.length]" />
        <span class="block h-2 rounded-full bg-surface-2/70" :class="widths[(i + 2) % widths.length]" />
      </div>
      <span class="hidden h-5 w-16 shrink-0 rounded-full bg-surface-2 sm:block" />
      <span class="hidden h-2.5 w-24 shrink-0 rounded-full bg-surface-2/70 md:block" />
    </div>
    <span class="sr-only">{{ t("common.loading") }}</span>
  </div>
</template>
