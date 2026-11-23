<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import SettingField from "../../settings/SettingField.vue";
import SettingSwitchRow from "../../settings/SettingSwitchRow.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiIcon from "../../ui/UiIcon.vue";
import type { ArchiveDraft } from "./dbBackupUtil";

/** Monthly archive rule: which days of the month keep an archive copy, and how many copies stay. */
const props = defineProps<{
  modelValue: ArchiveDraft;
  daysError?: string | null;
  countError?: string | null;
  dirty: { enabled: boolean; days: boolean; retention: boolean };
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: ArchiveDraft): void }>();

const { t } = useI18n();
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

function update(patch: Partial<ArchiveDraft>) {
  emit("update:modelValue", { ...props.modelValue, ...patch });
}

function toggleDay(day: number) {
  const days = props.modelValue.days.includes(day) ? props.modelValue.days.filter((d) => d !== day) : [...props.modelValue.days, day];
  update({ days: days.sort((a, b) => a - b) });
}

const selectedCount = computed(() => props.modelValue.days.length + (props.modelValue.includeMonthEnd ? 1 : 0));

type Mode = "forever" | "count";
const mode = computed<Mode>({
  get: () => (props.modelValue.forever ? "forever" : "count"),
  set: (value) => update({ forever: value === "forever" }),
});
const modeOptions = computed<{ value: Mode; label: string }[]>(() => [
  { value: "forever", label: t("dbBackups.archive.forever") },
  { value: "count", label: t("dbBackups.archive.keepLatest") },
]);

function onCount(ev: Event) {
  const el = ev.target as HTMLInputElement;
  update({ count: el.value === "" ? "" : el.valueAsNumber });
}
</script>

<template>
  <div>
    <SettingSwitchRow
      :model-value="modelValue.enabled"
      icon="crown"
      tone="warning"
      :title="t('dbBackups.archive.enabled')"
      :description="t('dbBackups.archive.enabledHint')"
      :dirty="dirty.enabled"
      @update:model-value="update({ enabled: $event })"
    />

    <div class="mt-4 border-t border-line/70 pt-4 transition-opacity duration-200" :class="modelValue.enabled ? '' : 'opacity-60'">
      <div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SettingField :label="t('dbBackups.archive.days')" :error="daysError" :hint="t('dbBackups.archive.daysHint')" :dirty="dirty.days">
          <template #aside>
            <div class="flex items-center gap-2 text-2xs text-fg-subtle">
              <span class="tabular-nums">{{ t("dbBackups.archive.selected", { n: selectedCount }) }}</span>
              <button
                v-if="selectedCount"
                type="button"
                class="cursor-pointer font-medium text-accent hover:underline"
                @click="update({ days: [], includeMonthEnd: false })"
              >
                {{ t("dbBackups.archive.clear") }}
              </button>
            </div>
          </template>
          <div class="grid grid-cols-7 gap-1.5" role="group" :aria-label="t('dbBackups.archive.days')">
            <button
              v-for="d in DAYS"
              :key="d"
              type="button"
              :aria-pressed="modelValue.days.includes(d)"
              :aria-label="t('dbBackups.archive.day', { day: d })"
              class="h-9 min-w-0 rounded-lg border text-xs font-medium tabular-nums transition-[background-color,border-color,color,transform] duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-95 motion-reduce:active:scale-100"
              :class="
                modelValue.days.includes(d)
                  ? 'border-accent bg-accent-solid text-accent-fg shadow-sm'
                  : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg dark:bg-surface-2/40'
              "
              @click="toggleDay(d)"
            >
              {{ d }}
            </button>
            <button
              type="button"
              :aria-pressed="modelValue.includeMonthEnd"
              class="col-span-4 h-9 rounded-lg border text-xs font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-95 motion-reduce:active:scale-100"
              :class="
                modelValue.includeMonthEnd
                  ? 'border-accent bg-accent-solid text-accent-fg shadow-sm'
                  : 'border-dashed border-line-strong bg-surface text-fg-muted hover:text-fg dark:bg-surface-2/40'
              "
              @click="update({ includeMonthEnd: !modelValue.includeMonthEnd })"
            >
              {{ t("dbBackups.archive.monthEnd") }}
            </button>
          </div>
        </SettingField>

        <div class="min-w-0 space-y-4">
          <SettingField
            input-id="db-backup-archive-count"
            :label="t('dbBackups.archive.retention')"
            :error="countError"
            :hint="modelValue.forever ? t('dbBackups.archive.foreverHint') : t('dbBackups.archive.countHint')"
            :dirty="dirty.retention"
          >
            <SegmentedControl v-model="mode" :options="modeOptions" size="md" block />
            <Transition
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              enter-from-class="-translate-y-1 opacity-0"
              leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
              leave-to-class="opacity-0"
            >
              <div v-if="!modelValue.forever" class="mt-2 flex items-center gap-2">
                <input
                  id="db-backup-archive-count"
                  :value="modelValue.count"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  inputmode="numeric"
                  class="input w-28 tabular-nums"
                  :class="countError ? '!border-danger focus:!ring-danger/20' : ''"
                  :aria-invalid="Boolean(countError) || undefined"
                  @input="onCount"
                />
                <span class="text-xs text-fg-muted">{{ t("dbBackups.schedule.unitCopies") }}</span>
              </div>
            </Transition>
          </SettingField>

          <ul class="space-y-2 text-2xs leading-relaxed text-fg-subtle">
            <li v-if="!modelValue.enabled" class="flex items-start gap-1.5 text-warning">
              <UiIcon name="pause" :size="12" class="mt-px shrink-0" />{{ t("dbBackups.archive.disabledHint") }}
            </li>
            <li class="flex items-start gap-1.5"><UiIcon name="calendar" :size="12" class="mt-px shrink-0" />{{ t("dbBackups.archive.fallbackHint") }}</li>
            <li class="flex items-start gap-1.5"><UiIcon name="info" :size="12" class="mt-px shrink-0" />{{ t("dbBackups.archive.independentHint") }}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
