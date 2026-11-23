<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import RuntimeLogConfigCard from "../../components/admin/system-logs/RuntimeLogConfigCard.vue";
import SystemLogHealthCard from "../../components/admin/system-logs/SystemLogHealthCard.vue";
import SystemLogTable from "../../components/admin/system-logs/SystemLogTable.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";

/**
 * Admin → System logs: the persisted warnings, errors and audit entries of the console (bff),
 * the edge (net) and the data-plane core, the health of the pipeline that stores them, and the
 * runtime log configuration.
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

type Tab = "logs" | "settings";
const tab = ref<Tab>(route.query.tab === "settings" ? "settings" : "logs");
const tabs = computed(() => [
  { key: "logs" as Tab, label: t("systemLogs.tabs.logs"), icon: "terminal" as const },
  { key: "settings" as Tab, label: t("systemLogs.tabs.settings"), icon: "sliders" as const },
]);

// The settings tab mounts on first visit, then stays mounted so unsaved edits survive tab switches.
const settingsVisited = ref(tab.value === "settings");
watch(tab, (value) => {
  if (value === "settings") settingsVisited.value = true;
  const query = { ...route.query };
  if (value === "settings") query.tab = "settings";
  else delete query.tab;
  void router.replace({ query });
});

/** Bumped after a cleanup so the health strip shows the new counters at once. */
const healthToken = ref(0);
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('systemLogs.title')">
      <template #meta>
        <span class="hidden text-sm text-fg-subtle lg:inline">{{ t("systemLogs.subtitle") }}</span>
      </template>
      <template #actions>
        <RouterLink to="/admin/audit-logs" class="btn btn-secondary" :aria-label="t('nav.auditLogs')" :title="t('nav.auditLogs')">
          <UiIcon name="scroll" :size="15" />
          <span class="hidden sm:inline">{{ t("nav.auditLogs") }}</span>
        </RouterLink>
        <RouterLink to="/admin/ops" class="btn btn-secondary" :aria-label="t('nav.ops')" :title="t('nav.ops')">
          <UiIcon name="activity" :size="15" />
          <span class="hidden sm:inline">{{ t("nav.ops") }}</span>
        </RouterLink>
      </template>
    </PageHeader>

    <SystemLogHealthCard
      class="animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none"
      :refresh-token="healthToken"
    />

    <div class="animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none" :style="{ animationDelay: '60ms' }">
      <UiTabs v-model="tab" :tabs="tabs" />
      <div class="pt-5">
        <SystemLogTable v-show="tab === 'logs'" :active="tab === 'logs'" @cleaned="healthToken++" />
        <RuntimeLogConfigCard v-if="settingsVisited" v-show="tab === 'settings'" />
      </div>
    </div>
  </div>
</template>
