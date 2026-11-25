<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "./UiIcon.vue";
import UiSelect from "./UiSelect.vue";

const props = withDefaults(
  defineProps<{
    page: number;
    pageSize: number;
    total: number;
    pageSizes?: number[];
    disabled?: boolean;
  }>(),
  { pageSizes: () => [20, 50, 100], disabled: false },
);

const emit = defineEmits<{
  (e: "update:page", value: number): void;
  (e: "update:pageSize", value: number): void;
}>();

const { t } = useI18n();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1));
const to = computed(() => Math.min(props.total, props.page * props.pageSize));

/** Compact window of page numbers with ellipses: 1 … 4 5 [6] 7 8 … 20 */
const pages = computed<(number | "gap")[]>(() => {
  const n = pageCount.value;
  const cur = props.page;
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
  const out: (number | "gap")[] = [1];
  const start = Math.max(2, cur - 1);
  const end = Math.min(n - 1, cur + 1);
  if (start > 2) out.push("gap");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < n - 1) out.push("gap");
  out.push(n);
  return out;
});

function go(p: number) {
  const next = Math.min(pageCount.value, Math.max(1, p));
  if (next !== props.page) emit("update:page", next);
}

function onSize(value: unknown) {
  emit("update:pageSize", Number(value));
  emit("update:page", 1);
}
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line/70 px-5 py-3 text-xs text-fg-muted">
    <div class="flex items-center gap-3">
      <span class="tabular-nums">{{ t("pagination.range", { from, to, total }) }}</span>
      <label class="flex items-center gap-1.5">
        <span class="sr-only">{{ t("pagination.pageSize") }}</span>
        <UiSelect class="select input-sm h-7 w-auto py-0 pr-7 text-xs" :model-value="pageSize" :disabled="disabled" @change="onSize">
          <option v-for="s in pageSizes" :key="s" :value="s">{{ t("pagination.perPage", { n: s }) }}</option>
        </UiSelect>
      </label>
    </div>
    <nav class="flex items-center gap-1" :aria-label="t('pagination.label')">
      <button type="button" class="pg-btn" :disabled="disabled || page <= 1" :aria-label="t('pagination.prev')" @click="go(page - 1)">
        <UiIcon name="chevron-left" :size="14" />
      </button>
      <template v-for="(p, i) in pages" :key="`${p}-${i}`">
        <span v-if="p === 'gap'" class="px-1 text-fg-subtle">…</span>
        <button
          v-else
          type="button"
          class="pg-btn tabular-nums"
          :class="{ 'pg-btn-active': p === page }"
          :disabled="disabled"
          :aria-current="p === page ? 'page' : undefined"
          @click="go(p)"
        >
          {{ p }}
        </button>
      </template>
      <button
        type="button"
        class="pg-btn"
        :disabled="disabled || page >= pageCount"
        :aria-label="t('pagination.next')"
        @click="go(page + 1)"
      >
        <UiIcon name="chevron-right" :size="14" />
      </button>
    </nav>
  </div>
</template>

<style scoped>
.pg-btn {
  @apply inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-md px-1.5 text-xs font-medium text-fg-muted transition-[color,background-color,box-shadow,transform] duration-150 hover:bg-surface-2 hover:text-fg active:scale-90 disabled:pointer-events-none disabled:opacity-40 motion-reduce:active:scale-100;
}
.pg-btn-active {
  @apply bg-accent/10 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/15 hover:text-accent;
  animation: pg-pop 320ms var(--ease-spring);
}
@keyframes pg-pop {
  from {
    transform: scale(0.8);
  }
}
</style>
