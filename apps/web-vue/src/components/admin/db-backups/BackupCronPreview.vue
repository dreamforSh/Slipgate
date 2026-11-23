<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupCronPreviewResponse } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson, toQuery } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
import { backupCodeText, DB_BACKUP_API, formatInZone, formatStamp, isKnownZone } from "./dbBackupUtil";

/**
 * Live check of the (unsaved) cron expression: the server parses it exactly as it will when saving
 * and lists the next runs, shown in the schedule's time zone with the viewer's local time on hover.
 */
const props = defineProps<{ cronExpr: string; timezone: string; enabled: boolean }>();
const emit = defineEmits<{ (e: "result", value: BackupCronPreviewResponse | null): void }>();

const { t } = useI18n();

const result = ref<BackupCronPreviewResponse | null>(null);
const loading = ref(false);
const failed = ref(false);
let timer: number | undefined;
let controller: AbortController | null = null;
let seq = 0;

function publish(value: BackupCronPreviewResponse | null) {
  result.value = value;
  emit("result", value);
}

async function check(expr: string, zone: string) {
  const mine = ++seq;
  controller?.abort();
  if (!expr) {
    loading.value = false;
    failed.value = false;
    publish(null);
    return;
  }
  if (!isKnownZone(zone)) {
    loading.value = false;
    failed.value = false;
    publish({ valid: false, error: "backup_invalid_timezone", message: "", runsIso: [] });
    return;
  }
  controller = new AbortController();
  loading.value = true;
  try {
    const res = await apiJson<BackupCronPreviewResponse>(`${DB_BACKUP_API}/schedule/preview${toQuery({ cronExpr: expr, timezone: zone, count: 5 })}`, {
      signal: controller.signal,
    });
    if (mine !== seq) return;
    failed.value = false;
    publish(res);
  } catch (err) {
    if (mine !== seq || (err instanceof DOMException && err.name === "AbortError")) return;
    failed.value = true;
    publish(null);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(
  () => [props.cronExpr.trim(), props.timezone.trim()] as const,
  ([expr, zone]) => {
    window.clearTimeout(timer);
    loading.value = Boolean(expr);
    timer = window.setTimeout(() => void check(expr, zone), 350);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.clearTimeout(timer);
  controller?.abort();
});
</script>

<template>
  <div class="rounded-xl border border-line bg-surface-2/40 px-3.5 py-3" aria-live="polite">
    <div class="flex items-center justify-between gap-2">
      <p class="eyebrow">{{ t("dbBackups.schedule.preview") }}</p>
      <UiIcon v-if="loading" name="loader" :size="12" spin class="text-fg-subtle" />
    </div>
    <p v-if="!enabled && result?.valid" class="mt-1 text-2xs text-fg-subtle">{{ t("dbBackups.schedule.previewOff") }}</p>

    <Transition
      mode="out-in"
      enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0"
    >
      <p v-if="failed" key="failed" class="mt-2 text-xs text-fg-subtle">{{ t("dbBackups.schedule.previewFailed") }}</p>
      <!-- An unknown time zone is reported on the time zone field itself. -->
      <p v-else-if="result && !result.valid && result.error === 'backup_invalid_timezone'" key="tz" class="mt-2 text-xs text-fg-subtle">—</p>
      <p v-else-if="result && !result.valid" key="invalid" class="mt-2 flex items-start gap-1.5 text-xs text-danger" role="alert">
        <UiIcon name="alert" :size="12" class="mt-0.5 shrink-0" />
        <span class="min-w-0 break-words">{{ backupCodeText(result.error, result.message, t("dbBackups.schedule.previewFailed")) }}</span>
      </p>
      <ol v-else-if="result" key="runs" class="mt-2 space-y-1.5">
        <li v-for="(iso, i) in result.runsIso" :key="iso" class="flex min-w-0 items-center gap-2.5 text-xs">
          <span
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums"
            :class="i === 0 ? 'bg-accent/15 text-accent' : 'bg-surface-3/70 text-fg-subtle dark:bg-surface-3/50'"
          >
            {{ i + 1 }}
          </span>
          <span class="min-w-0 truncate tabular-nums text-fg" :title="t('dbBackups.schedule.previewLocal', { time: formatStamp(iso) })">
            {{ formatInZone(iso, timezone.trim()) }}
          </span>
          <span class="ml-auto shrink-0 text-2xs text-fg-subtle">{{ formatRelative(iso) }}</span>
        </li>
      </ol>
      <p v-else-if="loading" key="loading" class="mt-2 text-xs text-fg-subtle">{{ t("dbBackups.schedule.previewChecking") }}</p>
    </Transition>
  </div>
</template>
