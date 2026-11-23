<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import BackupSettingsPanel from "../../components/admin/db-backups/BackupSettingsPanel.vue";
import BackupsPanel from "../../components/admin/db-backups/BackupsPanel.vue";
import { useDbBackups } from "../../components/admin/db-backups/useDbBackups";
import BackupImportCard from "../../components/admin/tools/BackupImportCard.vue";
import BackupScopeCard from "../../components/admin/tools/BackupScopeCard.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { downloadFile, errorText } from "../../lib/api";
import { formatDateShort, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

/**
 * Backup & restore: full database backups to S3 (history, run now, download, restore), their
 * storage / schedule / monthly archive settings, and the lighter configuration export / import.
 */
const { t } = useI18n();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();
const ctl = useDbBackups();

/* ---------------- Tabs (kept mounted once visited, so unsaved settings survive a switch) ---------------- */

type Tab = "backups" | "settings" | "config";
const TAB_KEYS: Tab[] = ["backups", "settings", "config"];
const TAB_ICONS: Record<Tab, IconName> = { backups: "database", settings: "sliders", config: "braces" };

const queryTab = route.query.tab;
const initial: Tab = typeof queryTab === "string" && (TAB_KEYS as string[]).includes(queryTab) ? (queryTab as Tab) : "backups";
const tab = ref<Tab>(initial);
const visited = reactive<Record<Tab, boolean>>({ backups: initial === "backups", settings: initial === "settings", config: initial === "config" });
const settingsDirty = ref(0);

watch(tab, (value) => {
  visited[value] = true;
  void router.replace({ query: { ...route.query, tab: value === "backups" ? undefined : value } });
});

const tabs = computed(() =>
  TAB_KEYS.map((key) => ({
    key,
    label: t(`dbBackups.tabs.${key}`),
    icon: TAB_ICONS[key],
    ...(key === "settings" && settingsDirty.value > 0 ? { count: settingsDirty.value } : {}),
  })),
);

/* ---------------- Page status ---------------- */

const pageStatus = computed<{ tone: Tone; text: string; pulse: boolean }>(() => {
  const s = ctl.status;
  if (!s) return { tone: "neutral", text: t("dbBackups.pageStatus.checking"), pulse: false };
  if (s.activeOperation?.kind === "restore") return { tone: "warning", text: t("dbBackups.pageStatus.restoring"), pulse: true };
  if (s.activeOperation) return { tone: "info", text: t("dbBackups.pageStatus.backingUp"), pulse: true };
  if (!s.supported) return { tone: "danger", text: t("dbBackups.pageStatus.unsupported"), pulse: false };
  if (!s.s3Configured) return { tone: "warning", text: t("dbBackups.pageStatus.noStorage"), pulse: false };
  return { tone: "success", text: t("dbBackups.pageStatus.ready"), pulse: false };
});

/* ---------------- Configuration export ---------------- */

const exporting = ref(false);

async function exportConfig() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await downloadFile("/api/v1/admin/backup/export", `slipgate-config-${formatDateShort(new Date().toISOString())}.json`);
    toast.success(t("adminTools.backup.export.done"));
  } catch (err) {
    toast.error(errorText(err, t("adminTools.backup.errors.export")));
  } finally {
    exporting.value = false;
  }
}

const panelEnter = "animate-slide-up motion-reduce:animate-none";
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.backup')">
      <template #meta>
        <UiBadge :tone="pageStatus.tone" dot :pulse="pageStatus.pulse">{{ pageStatus.text }}</UiBadge>
      </template>
    </PageHeader>

    <UiTabs v-model="tab" :tabs="tabs" />

    <!-- Database backups -->
    <div v-if="visited.backups" v-show="tab === 'backups'" role="tabpanel" :class="panelEnter">
      <BackupsPanel :ctl="ctl" @configure="tab = 'settings'" />
    </div>

    <!-- Storage & schedule -->
    <div v-if="visited.settings" v-show="tab === 'settings'" role="tabpanel" :class="panelEnter">
      <BackupSettingsPanel :active="tab === 'settings'" @saved="ctl.refreshStatus()" @dirty="settingsDirty = $event" />
    </div>

    <!-- Configuration export / import -->
    <div v-if="visited.config" v-show="tab === 'config'" role="tabpanel" class="space-y-6" :class="panelEnter">
      <UiAlert tone="info">{{ t("dbBackups.config.note") }}</UiAlert>
      <div class="grid items-start gap-6 lg:grid-cols-5">
        <div class="min-w-0 space-y-6 lg:col-span-2">
          <UiCard icon="download" :title="t('adminTools.backup.export.title')">
            <p class="text-sm leading-relaxed text-fg-muted">{{ t("adminTools.backup.export.body") }}</p>
            <p class="mt-2 flex items-center gap-1.5 text-2xs text-fg-subtle">
              <UiIcon name="file" :size="12" />
              <span class="min-w-0 truncate">{{ t("adminTools.backup.export.fileName") }}</span>
            </p>
            <button type="button" class="btn btn-primary mt-4 w-full sm:w-auto" :disabled="exporting" @click="exportConfig">
              <UiIcon :name="exporting ? 'loader' : 'download'" :size="15" :spin="exporting" />
              {{ exporting ? t("adminTools.backup.export.exporting") : t("adminTools.backup.export.action") }}
            </button>
          </UiCard>
          <BackupScopeCard />
        </div>
        <BackupImportCard class="lg:col-span-3" />
      </div>
    </div>
  </div>
</template>
