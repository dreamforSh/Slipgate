<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import {
  DB_BACKUP_DEFAULT_PREFIX,
  DEFAULT_BACKUP_S3_CONFIG,
  DEFAULT_BACKUP_SCHEDULE,
  UpdateBackupS3ConfigRequestSchema,
  type BackupCronPreviewResponse,
  type BackupMonthlyArchiveConfig,
  type BackupS3ConfigView,
  type BackupSchedule,
  type BackupScheduleView,
  type TestBackupS3Response,
  type UpdateBackupS3ConfigRequest,
} from "@slipgate/contracts";
import SecretInput from "../../payments/SecretInput.vue";
import SettingField from "../../settings/SettingField.vue";
import SettingSwitchRow from "../../settings/SettingSwitchRow.vue";
import SettingsSaveBar from "../../settings/SettingsSaveBar.vue";
import CopyButton from "../../ui/CopyButton.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { ApiError, apiJson } from "../../../lib/api";
import type { Tone } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import BackupArchiveEditor from "./BackupArchiveEditor.vue";
import BackupCronPreview from "./BackupCronPreview.vue";
import BackupS3GuideModal from "./BackupS3GuideModal.vue";
import {
  backupCodeText,
  backupErrorText,
  browserZone,
  CRON_PRESETS,
  DB_BACKUP_API,
  isKnownZone,
  timeZones,
  type ArchiveDraft,
} from "./dbBackupUtil";

/**
 * "Storage & schedule" tab: the S3 target (with a connection test of the unsaved values), the cron
 * schedule with retention, and the monthly archive rule. One save bar saves whichever section changed.
 */
const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ (e: "saved"): void; (e: "dirty", count: number): void }>();

const { t, locale } = useI18n();
const toast = useToastStore();

/* ---------------- Drafts ---------------- */

interface S3Draft {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  prefix: string;
  forcePathStyle: boolean;
  /** undefined = keep the stored secret, "" = clear it, otherwise replace. */
  secret: string | undefined;
}

interface ScheduleDraft {
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  retainDays: number | string;
  retainCount: number | string;
  archive: ArchiveDraft;
}

function fromS3(v: BackupS3ConfigView): S3Draft {
  return {
    endpoint: v.endpoint,
    region: v.region,
    bucket: v.bucket,
    accessKeyId: v.accessKeyId,
    prefix: v.prefix,
    forcePathStyle: v.forcePathStyle,
    secret: undefined,
  };
}

function fromSchedule(v: BackupSchedule): ScheduleDraft {
  const a = v.monthlyArchive;
  return {
    enabled: v.enabled,
    cronExpr: v.cronExpr,
    timezone: v.timezone,
    retainDays: v.retainDays,
    retainCount: v.retainCount,
    archive: {
      enabled: a.enabled,
      days: [...a.days],
      includeMonthEnd: a.includeMonthEnd,
      forever: a.retainCount === 0,
      count: a.retainCount || DEFAULT_BACKUP_SCHEDULE.monthlyArchive.retainCount,
    },
  };
}

const s3Orig = ref<BackupS3ConfigView | null>(null);
const schedOrig = ref<BackupScheduleView | null>(null);
const s3 = reactive<S3Draft>(fromS3(DEFAULT_BACKUP_S3_CONFIG));
const sched = reactive<ScheduleDraft>(fromSchedule(DEFAULT_BACKUP_SCHEDULE));

const loading = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    const [s3View, schedView] = await Promise.all([
      apiJson<BackupS3ConfigView>(`${DB_BACKUP_API}/s3-config`, { fallbackError: t("dbBackups.settings.loadFailed") }),
      apiJson<BackupScheduleView>(`${DB_BACKUP_API}/schedule`, { fallbackError: t("dbBackups.settings.loadFailed") }),
    ]);
    s3Orig.value = s3View;
    schedOrig.value = schedView;
    Object.assign(s3, fromS3(s3View));
    Object.assign(sched, fromSchedule(schedView));
    loadError.value = null;
  } catch (err) {
    loadError.value = backupErrorText(err, t("dbBackups.settings.loadFailed"));
  } finally {
    loading.value = false;
  }
}

/* ---------------- Request bodies ---------------- */

const intVal = (v: number | string): number => (v === "" ? Number.NaN : typeof v === "number" ? v : Number(v));
const intIn = (v: number | string, min: number, max: number) => {
  const n = intVal(v);
  return Number.isInteger(n) && n >= min && n <= max;
};

const s3Body = computed<UpdateBackupS3ConfigRequest>(() => ({
  endpoint: s3.endpoint.trim(),
  region: s3.region.trim(),
  bucket: s3.bucket.trim(),
  accessKeyId: s3.accessKeyId.trim(),
  prefix: s3.prefix.trim().replace(/^\/+|\/+$/g, ""),
  forcePathStyle: s3.forcePathStyle,
  ...(s3.secret !== undefined ? { secretAccessKey: s3.secret } : {}),
}));

const archiveBody = computed<BackupMonthlyArchiveConfig>(() => {
  const a = sched.archive;
  const saved = schedOrig.value?.monthlyArchive ?? DEFAULT_BACKUP_SCHEDULE.monthlyArchive;
  // A switched-off rule keeps its last valid pool size rather than failing on a half-typed one.
  const count = intIn(a.count, 1, 1000) ? intVal(a.count) : saved.retainCount;
  return {
    enabled: a.enabled,
    days: [...new Set(a.days)].sort((x, y) => x - y),
    includeMonthEnd: a.includeMonthEnd,
    retainCount: a.forever ? 0 : count,
  };
});

const schedBody = computed<BackupSchedule>(() => ({
  enabled: sched.enabled,
  cronExpr: sched.cronExpr.trim(),
  timezone: sched.timezone.trim(),
  retainDays: intVal(sched.retainDays),
  retainCount: intVal(sched.retainCount),
  monthlyArchive: archiveBody.value,
}));

/* ---------------- Dirty tracking ---------------- */

const s3Keys = computed<string[]>(() => {
  const o = s3Orig.value;
  if (!o) return [];
  const b = s3Body.value;
  const keys: string[] = [];
  if (b.endpoint.replace(/\/+$/, "") !== o.endpoint) keys.push("endpoint");
  if (b.region !== o.region) keys.push("region");
  if (b.bucket !== o.bucket) keys.push("bucket");
  if (b.accessKeyId !== o.accessKeyId) keys.push("accessKeyId");
  if (b.prefix !== o.prefix) keys.push("prefix");
  if (b.forcePathStyle !== o.forcePathStyle) keys.push("forcePathStyle");
  if (s3.secret !== undefined && !(s3.secret === "" && !o.secretAccessKeySet)) keys.push("secret");
  return keys;
});

const schedKeys = computed<string[]>(() => {
  const o = schedOrig.value;
  if (!o) return [];
  const b = schedBody.value;
  const keys: string[] = [];
  if (b.enabled !== o.enabled) keys.push("enabled");
  if (b.cronExpr !== o.cronExpr) keys.push("cronExpr");
  if (b.timezone !== o.timezone) keys.push("timezone");
  if (b.retainDays !== o.retainDays) keys.push("retainDays");
  if (b.retainCount !== o.retainCount) keys.push("retainCount");
  const a = b.monthlyArchive;
  const oa = o.monthlyArchive;
  if (a.enabled !== oa.enabled) keys.push("archive.enabled");
  if (a.days.join(",") !== oa.days.join(",") || a.includeMonthEnd !== oa.includeMonthEnd) keys.push("archive.days");
  if (a.retainCount !== oa.retainCount || (!sched.archive.forever && !intIn(sched.archive.count, 1, 1000))) keys.push("archive.retention");
  return keys;
});

const dirtyCount = computed(() => s3Keys.value.length + schedKeys.value.length);
const isDirty = (key: string) => s3Keys.value.includes(key) || schedKeys.value.includes(key);

watch(dirtyCount, (n) => emit("dirty", n), { immediate: true });

/* ---------------- Validation ---------------- */

type S3Field = "endpoint" | "bucket" | "region" | "prefix";

const s3Errors = computed<Partial<Record<S3Field, string>>>(() => {
  const e: Partial<Record<S3Field, string>> = {};
  const parsed = UpdateBackupS3ConfigRequestSchema.safeParse(s3Body.value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if ((k === "endpoint" || k === "bucket" || k === "region" || k === "prefix") && !e[k]) e[k] = t(`dbBackups.s3.errors.${k}`);
    }
  }
  return e;
});

const preview = ref<BackupCronPreviewResponse | null>(null);
const serverErr = reactive<{ cron: string | null; timezone: string | null }>({ cron: null, timezone: null });
watch(
  () => sched.cronExpr,
  () => (serverErr.cron = null),
);
watch(
  () => sched.timezone,
  () => (serverErr.timezone = null),
);

/** The live preview says the expression is rejected (the message itself shows in the preview box). */
const cronInvalid = computed(
  () => Boolean(sched.cronExpr.trim()) && preview.value !== null && !preview.value.valid && preview.value.error === "backup_invalid_cron",
);

type SchedField = "cron" | "timezone" | "retainDays" | "retainCount" | "archiveDays" | "archiveCount";

const schedErrors = computed<Partial<Record<SchedField, string>>>(() => {
  const e: Partial<Record<SchedField, string>> = {};
  if (sched.enabled && !sched.cronExpr.trim()) e.cron = t("dbBackups.schedule.errors.cronRequired");
  else if (serverErr.cron) e.cron = serverErr.cron;
  if (!isKnownZone(sched.timezone.trim())) e.timezone = t("dbBackups.schedule.timezoneInvalid");
  else if (serverErr.timezone) e.timezone = serverErr.timezone;
  if (!intIn(sched.retainDays, 0, 3650)) e.retainDays = t("dbBackups.schedule.errors.int", { min: 0, max: 3650 });
  if (!intIn(sched.retainCount, 0, 1000)) e.retainCount = t("dbBackups.schedule.errors.int", { min: 0, max: 1000 });
  if (sched.archive.enabled) {
    if (sched.archive.days.length === 0 && !sched.archive.includeMonthEnd) e.archiveDays = t("dbBackups.archive.errors.days");
    if (!sched.archive.forever && !intIn(sched.archive.count, 1, 1000)) e.archiveCount = t("dbBackups.schedule.errors.int", { min: 1, max: 1000 });
  }
  return e;
});

const s3Invalid = computed(() => Object.keys(s3Errors.value).length > 0);
const schedInvalid = computed(() => Object.keys(schedErrors.value).length > 0 || cronInvalid.value);
/** Only a section that is about to be saved can block the save. */
const invalid = computed(() => (s3Keys.value.length > 0 && s3Invalid.value) || (schedKeys.value.length > 0 && schedInvalid.value));

/* ---------------- Save ---------------- */

async function save() {
  if (saving.value || !dirtyCount.value) return;
  if (invalid.value) {
    toast.error(t("settings.saveBar.invalid"));
    return;
  }
  saving.value = true;
  let ok = true;
  let changed = false;
  try {
    if (s3Keys.value.length) {
      try {
        const view = await apiJson<BackupS3ConfigView>(`${DB_BACKUP_API}/s3-config`, {
          method: "PUT",
          body: s3Body.value,
          fallbackError: t("dbBackups.settings.saveFailed"),
        });
        s3Orig.value = view;
        Object.assign(s3, fromS3(view));
        testResult.value = null;
        changed = true;
      } catch (err) {
        ok = false;
        toast.error(backupErrorText(err, t("dbBackups.settings.saveFailed")));
      }
    }
    if (schedKeys.value.length) {
      try {
        const view = await apiJson<BackupScheduleView>(`${DB_BACKUP_API}/schedule`, {
          method: "PUT",
          body: schedBody.value,
          fallbackError: t("dbBackups.settings.saveFailed"),
        });
        schedOrig.value = view;
        Object.assign(sched, fromSchedule(view));
        changed = true;
      } catch (err) {
        ok = false;
        const text = backupErrorText(err, t("dbBackups.settings.saveFailed"));
        if (err instanceof ApiError && err.code === "backup_invalid_cron") serverErr.cron = text;
        else if (err instanceof ApiError && err.code === "backup_invalid_timezone") serverErr.timezone = text;
        toast.error(text);
      }
    }
    if (ok) toast.success(t("dbBackups.settings.saved"));
    if (changed) emit("saved");
  } finally {
    saving.value = false;
  }
}

function discard() {
  if (s3Orig.value) Object.assign(s3, fromS3(s3Orig.value));
  if (schedOrig.value) Object.assign(sched, fromSchedule(schedOrig.value));
  serverErr.cron = null;
  serverErr.timezone = null;
}

function reload() {
  if (dirtyCount.value && !window.confirm(t("dbBackups.settings.leaveConfirm"))) return;
  void load();
}

/* ---------------- Connection test ---------------- */

const testing = ref(false);
const testResult = ref<TestBackupS3Response | null>(null);

watch(
  () => JSON.stringify(s3Body.value),
  () => (testResult.value = null),
);

async function testConnection() {
  if (testing.value || s3Invalid.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await apiJson<TestBackupS3Response>(`${DB_BACKUP_API}/s3-config/test`, {
      method: "POST",
      body: s3Body.value,
      fallbackError: t("dbBackups.s3.testFailed"),
    });
  } catch (err) {
    testResult.value = { ok: false, message: backupErrorText(err, t("dbBackups.s3.testFailed")) };
  } finally {
    testing.value = false;
  }
}

/* ---------------- Derived display ---------------- */

const secretSet = computed(() => (s3.secret === undefined ? Boolean(s3Orig.value?.secretAccessKeySet) : s3.secret !== ""));

const s3State = computed<{ tone: Tone; text: string }>(() => {
  if (s3.bucket.trim() && s3.accessKeyId.trim() && secretSet.value) return { tone: "success", text: t("dbBackups.s3.state.ready") };
  const any = s3.bucket.trim() || s3.accessKeyId.trim() || s3.endpoint.trim() || secretSet.value;
  return any ? { tone: "warning", text: t("dbBackups.s3.state.incomplete") } : { tone: "neutral", text: t("dbBackups.s3.state.empty") };
});

const keyPreview = computed(() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_030000`;
  return `s3://${s3Body.value.bucket || "<bucket>"}/${s3Body.value.prefix || DB_BACKUP_DEFAULT_PREFIX}/${date}/slipgate_${stamp}_bk_0123456789.sql.gz`;
});

const zones = timeZones();
const localZone = browserZone();

const listJoin = (items: string[]) => items.join(locale.value.startsWith("zh") ? "、" : ", ");

const summary = computed<string[]>(() => {
  const lines: string[] = [];
  const days = intVal(sched.retainDays);
  const count = intVal(sched.retainCount);
  if (Number.isInteger(days) && Number.isInteger(count)) {
    if (days > 0 && count > 0) lines.push(t("dbBackups.schedule.summaryBoth", { days, count }));
    else if (days > 0) lines.push(t("dbBackups.schedule.summaryDays", { days }));
    else if (count > 0) lines.push(t("dbBackups.schedule.summaryCount", { count }));
    else lines.push(t("dbBackups.schedule.summaryUnlimited"));
  }
  const a = sched.archive;
  if (a.enabled && (a.days.length || a.includeMonthEnd)) {
    const dates = [
      ...[...a.days].sort((x, y) => x - y).map((day) => t("dbBackups.archive.day", { day })),
      ...(a.includeMonthEnd ? [t("dbBackups.archive.monthEnd")] : []),
    ];
    const retention = a.forever
      ? t("dbBackups.schedule.summaryArchiveForever")
      : t("dbBackups.schedule.summaryArchivePool", { n: intIn(a.count, 1, 1000) ? intVal(a.count) : "?" });
    lines.push(t("dbBackups.schedule.summaryArchive", { dates: listJoin(dates), retention }));
  }
  lines.push(t("dbBackups.schedule.summaryManual"));
  return lines;
});

const guideOpen = ref(false);

/* ---------------- Guards & shortcuts ---------------- */

function onKeydown(ev: KeyboardEvent) {
  if (!props.active) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    void save();
  }
}

function onBeforeUnload(ev: BeforeUnloadEvent) {
  if (!dirtyCount.value) return;
  ev.preventDefault();
  ev.returnValue = "";
}

onBeforeRouteLeave(() => {
  if (dirtyCount.value && !saving.value) return window.confirm(t("dbBackups.settings.leaveConfirm"));
  return true;
});

onMounted(() => {
  void load();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", onBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

defineExpose({ reload });

const enter = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";
const delay = (i: number) => ({ animationDelay: `${i * 50}ms` });
const errorRing = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <div class="space-y-6">
    <UiAlert v-if="loadError && !s3Orig" tone="warning">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("dbBackups.history.retry") }}
        </button>
      </template>
    </UiAlert>

    <div v-if="!s3Orig && loading" class="grid gap-6 xl:grid-cols-2" aria-busy="true">
      <div v-for="i in 3" :key="i" class="card h-72 animate-pulse bg-surface-2/40 motion-reduce:animate-none" :class="i === 3 ? 'xl:col-span-2 h-56' : ''" />
    </div>

    <template v-else-if="s3Orig && schedOrig">
      <div class="grid items-start gap-6 xl:grid-cols-2">
        <!-- S3 storage -->
        <UiCard :class="enter" :style="delay(0)">
          <template #header>
            <div class="flex min-w-0 items-center gap-3">
              <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="server" :size="16" /></span>
              <div class="min-w-0">
                <h2 class="truncate text-sm font-semibold text-fg">{{ t("dbBackups.s3.title") }}</h2>
                <p class="truncate text-xs text-fg-subtle">{{ t("dbBackups.s3.desc") }}</p>
              </div>
            </div>
          </template>
          <template #actions>
            <UiBadge :tone="s3State.tone" dot>{{ s3State.text }}</UiBadge>
            <button type="button" class="btn btn-ghost btn-xs" @click="guideOpen = true">
              <UiIcon name="book-open" :size="13" />
              {{ t("dbBackups.s3.guide") }}
            </button>
          </template>

          <div class="grid gap-4 sm:grid-cols-2">
            <SettingField
              class="sm:col-span-2"
              input-id="db-s3-endpoint"
              :label="t('dbBackups.s3.endpoint')"
              :hint="t('dbBackups.s3.endpointHint')"
              :error="s3Errors.endpoint"
              :dirty="isDirty('endpoint')"
            >
              <input
                id="db-s3-endpoint"
                v-model="s3.endpoint"
                type="url"
                maxlength="512"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="s3Errors.endpoint ? errorRing : ''"
                :placeholder="t('dbBackups.s3.endpointPlaceholder')"
              />
            </SettingField>
            <SettingField
              input-id="db-s3-region"
              :label="t('dbBackups.s3.region')"
              :hint="t('dbBackups.s3.regionHint')"
              :error="s3Errors.region"
              :dirty="isDirty('region')"
            >
              <input
                id="db-s3-region"
                v-model="s3.region"
                type="text"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="s3Errors.region ? errorRing : ''"
                :placeholder="t('dbBackups.s3.regionPlaceholder')"
              />
            </SettingField>
            <SettingField
              input-id="db-s3-bucket"
              :label="t('dbBackups.s3.bucket')"
              :error="s3Errors.bucket"
              :dirty="isDirty('bucket')"
              required
            >
              <input
                id="db-s3-bucket"
                v-model="s3.bucket"
                type="text"
                maxlength="255"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="s3Errors.bucket ? errorRing : ''"
                placeholder="slipgate-backups"
              />
            </SettingField>
            <SettingField
              class="sm:col-span-2"
              input-id="db-s3-prefix"
              :label="t('dbBackups.s3.prefix')"
              :hint="t('dbBackups.s3.prefixHint')"
              :error="s3Errors.prefix"
              :dirty="isDirty('prefix')"
            >
              <input
                id="db-s3-prefix"
                v-model="s3.prefix"
                type="text"
                maxlength="256"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="s3Errors.prefix ? errorRing : ''"
                :placeholder="t('dbBackups.s3.prefixPlaceholder')"
              />
            </SettingField>
            <SettingField
              class="sm:col-span-2"
              input-id="db-s3-akid"
              :label="t('dbBackups.s3.accessKeyId')"
              :dirty="isDirty('accessKeyId')"
              required
            >
              <input
                id="db-s3-akid"
                v-model="s3.accessKeyId"
                type="text"
                maxlength="256"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
              />
            </SettingField>
            <div class="sm:col-span-2">
              <SecretInput v-model="s3.secret" :is-set="s3Orig.secretAccessKeySet" :label="t('dbBackups.s3.secret')" />
              <p class="mt-1 flex items-start gap-1.5 text-2xs text-fg-subtle">
                <UiIcon name="lock" :size="12" class="mt-px shrink-0" />
                {{ t("dbBackups.s3.secretHint") }}
              </p>
            </div>
          </div>

          <div class="mt-4 border-t border-line/70 pt-4">
            <SettingSwitchRow
              v-model="s3.forcePathStyle"
              icon="route"
              tone="info"
              :title="t('dbBackups.s3.pathStyle')"
              :description="t('dbBackups.s3.pathStyleHint')"
              :dirty="isDirty('forcePathStyle')"
            />
          </div>

          <div class="mt-4 min-w-0">
            <p class="label">{{ t("dbBackups.s3.keyPreview") }}</p>
            <div class="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-surface-2/50 py-1 pl-3 pr-1">
              <code class="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted" :title="keyPreview">{{ keyPreview }}</code>
              <CopyButton :text="keyPreview" />
            </div>
          </div>

          <template #footer>
            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="min-w-0 text-xs text-fg-subtle">{{ t("dbBackups.s3.testUnsaved") }}</span>
                <button type="button" class="btn btn-secondary btn-sm max-sm:w-full" :disabled="testing || s3Invalid" @click="testConnection">
                  <UiIcon :name="testing ? 'loader' : 'plug'" :size="14" :spin="testing" />
                  {{ testing ? t("dbBackups.s3.testing") : t("dbBackups.s3.test") }}
                </button>
              </div>
              <Transition
                enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                enter-from-class="-translate-y-1 opacity-0"
                leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
                leave-to-class="opacity-0"
              >
                <UiAlert v-if="testResult?.ok" tone="success">{{ t("dbBackups.s3.testOk") }}</UiAlert>
                <UiAlert v-else-if="testResult" tone="danger" :title="t('dbBackups.s3.testFailed')">
                  <span class="break-words">{{ backupCodeText(testResult.code, testResult.message, t("dbBackups.s3.testFailed")) }}</span>
                </UiAlert>
              </Transition>
            </div>
          </template>
        </UiCard>

        <!-- Schedule -->
        <UiCard icon="calendar" :title="t('dbBackups.schedule.title')" :class="enter" :style="delay(1)">
          <SettingSwitchRow
            v-model="sched.enabled"
            icon="clock"
            tone="success"
            :title="t('dbBackups.schedule.enabled')"
            :description="t('dbBackups.schedule.enabledHint')"
            :dirty="isDirty('enabled')"
          />

          <div class="mt-4 space-y-4 border-t border-line/70 pt-4">
            <SettingField
              input-id="db-schedule-cron"
              :label="t('dbBackups.schedule.cron')"
              :hint="t('dbBackups.schedule.cronHint')"
              :error="schedErrors.cron"
              :dirty="isDirty('cronExpr')"
              :required="sched.enabled"
            >
              <input
                id="db-schedule-cron"
                v-model="sched.cronExpr"
                type="text"
                maxlength="120"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono"
                :class="schedErrors.cron || cronInvalid ? errorRing : ''"
                :aria-invalid="Boolean(schedErrors.cron || cronInvalid) || undefined"
                placeholder="0 3 * * *"
              />
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="text-2xs text-fg-subtle">{{ t("dbBackups.schedule.presetsLabel") }}</span>
                <button
                  v-for="p in CRON_PRESETS"
                  :key="p.key"
                  type="button"
                  :aria-pressed="sched.cronExpr.trim() === p.expr"
                  :title="p.expr"
                  class="rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  :class="
                    sched.cronExpr.trim() === p.expr
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                  "
                  @click="sched.cronExpr = p.expr"
                >
                  {{ t(`dbBackups.schedule.presets.${p.key}`) }}
                </button>
              </div>
            </SettingField>

            <SettingField
              input-id="db-schedule-tz"
              :label="t('dbBackups.schedule.timezone')"
              :hint="t('dbBackups.schedule.timezoneHint')"
              :error="schedErrors.timezone"
              :dirty="isDirty('timezone')"
            >
              <input
                id="db-schedule-tz"
                v-model="sched.timezone"
                type="text"
                list="db-schedule-tz-list"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                class="input font-mono text-xs"
                :class="schedErrors.timezone ? errorRing : ''"
                placeholder="Asia/Shanghai"
              />
              <datalist id="db-schedule-tz-list">
                <option v-for="z in zones" :key="z" :value="z" />
              </datalist>
              <button
                v-if="sched.timezone.trim() !== localZone"
                type="button"
                class="mt-1.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded text-2xs font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                @click="sched.timezone = localZone"
              >
                <UiIcon name="globe" :size="11" class="shrink-0" />
                <span class="truncate">{{ t("dbBackups.schedule.useLocal", { tz: localZone }) }}</span>
              </button>
            </SettingField>

            <BackupCronPreview :cron-expr="sched.cronExpr" :timezone="sched.timezone" :enabled="sched.enabled" @result="preview = $event" />
          </div>

          <div class="mt-5 border-t border-line/70 pt-4">
            <p class="eyebrow mb-3">{{ t("dbBackups.schedule.retentionTitle") }}</p>
            <div class="grid gap-4 sm:grid-cols-2">
              <SettingField
                input-id="db-schedule-count"
                :label="t('dbBackups.schedule.retainCount')"
                :hint="t('dbBackups.schedule.retainCountHint')"
                :error="schedErrors.retainCount"
                :dirty="isDirty('retainCount')"
              >
                <div class="flex items-center gap-2">
                  <input
                    id="db-schedule-count"
                    v-model.number="sched.retainCount"
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    inputmode="numeric"
                    class="input tabular-nums"
                    :class="schedErrors.retainCount ? errorRing : ''"
                  />
                  <span class="shrink-0 text-xs text-fg-muted">{{ t("dbBackups.schedule.unitCopies") }}</span>
                </div>
              </SettingField>
              <SettingField
                input-id="db-schedule-days"
                :label="t('dbBackups.schedule.retainDays')"
                :hint="t('dbBackups.schedule.retainDaysHint')"
                :error="schedErrors.retainDays"
                :dirty="isDirty('retainDays')"
              >
                <div class="flex items-center gap-2">
                  <input
                    id="db-schedule-days"
                    v-model.number="sched.retainDays"
                    type="number"
                    min="0"
                    max="3650"
                    step="1"
                    inputmode="numeric"
                    class="input tabular-nums"
                    :class="schedErrors.retainDays ? errorRing : ''"
                  />
                  <span class="shrink-0 text-xs text-fg-muted">{{ t("dbBackups.schedule.unitDays") }}</span>
                </div>
              </SettingField>
            </div>
            <p class="mt-3 flex items-start gap-1.5 text-2xs leading-relaxed text-fg-subtle">
              <UiIcon name="info" :size="12" class="mt-px shrink-0" />
              {{ t("dbBackups.schedule.retentionNote") }}
            </p>
          </div>
        </UiCard>

        <!-- Monthly archive -->
        <UiCard icon="crown" :title="t('dbBackups.archive.title')" class="xl:col-span-2" :class="enter" :style="delay(2)">
          <BackupArchiveEditor
            v-model="sched.archive"
            :days-error="schedErrors.archiveDays"
            :count-error="schedErrors.archiveCount"
            :dirty="{ enabled: isDirty('archive.enabled'), days: isDirty('archive.days'), retention: isDirty('archive.retention') }"
          />
          <template #footer>
            <div class="flex items-start gap-3" aria-live="polite">
              <span class="icon-chip icon-chip-info mt-0.5 h-7 w-7"><UiIcon name="shield" :size="13" /></span>
              <div class="min-w-0">
                <p class="text-xs font-medium text-fg">{{ t("dbBackups.schedule.summaryTitle") }}</p>
                <ul class="mt-1 space-y-0.5 text-xs leading-relaxed text-fg-muted">
                  <li v-for="line in summary" :key="line">{{ line }}</li>
                </ul>
              </div>
            </div>
          </template>
        </UiCard>
      </div>

      <SettingsSaveBar :show="dirtyCount > 0" :count="dirtyCount" :saving="saving" :invalid="invalid" @save="save" @discard="discard" />
    </template>

    <BackupS3GuideModal v-model:open="guideOpen" />
  </div>
</template>
