<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { BACKUP_SECTIONS, NEVER_BACKED_UP } from "./backupSections";

/** What a configuration backup carries, and what it never does. */
const { t } = useI18n();
</script>

<template>
  <UiCard icon="shield" :title="t('adminTools.backup.scope.title')">
    <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
      <div class="min-w-0">
        <p class="eyebrow mb-2.5 flex items-center gap-1.5 !text-success">
          <UiIcon name="check-circle" :size="12" />
          {{ t("adminTools.backup.scope.included") }}
        </p>
        <ul class="space-y-1.5">
          <li v-for="s in BACKUP_SECTIONS" :key="s.key" class="flex min-w-0 items-center gap-2 text-xs text-fg">
            <span class="icon-chip h-6 w-6 rounded-md">
              <UiIcon :name="s.icon" :size="12" />
            </span>
            <span class="truncate">{{ t(`adminTools.backup.sections.${s.key}`) }}</span>
          </li>
        </ul>
      </div>
      <div class="min-w-0">
        <p class="eyebrow mb-2.5 flex items-center gap-1.5 !text-danger">
          <UiIcon name="x-circle" :size="12" />
          {{ t("adminTools.backup.scope.excluded") }}
        </p>
        <ul class="space-y-1.5">
          <li v-for="k in NEVER_BACKED_UP" :key="k" class="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
            <span class="icon-chip h-6 w-6 rounded-md bg-danger/[0.07] text-danger">
              <UiIcon name="lock" :size="12" />
            </span>
            <span class="min-w-0">{{ t(`adminTools.backup.scope.never.${k}`) }}</span>
          </li>
        </ul>
      </div>
    </div>
    <template #footer>
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
        <span class="inline-flex min-w-0 items-start gap-1.5">
          <UiIcon name="info" :size="13" class="mt-0.5 text-info" />
          {{ t("adminTools.backup.scope.accountsNote") }}
        </span>
        <RouterLink to="/admin/accounts" class="btn btn-ghost btn-xs shrink-0">
          {{ t("adminTools.backup.scope.accountsLink") }}
          <UiIcon name="arrow-right" :size="12" />
        </RouterLink>
      </div>
    </template>
  </UiCard>
</template>
