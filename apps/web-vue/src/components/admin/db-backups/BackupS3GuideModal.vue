<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";

/** How to fill the backup storage form for Cloudflare R2, AWS S3 and MinIO. */
defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();
const { t } = useI18n();

const r2Steps = ["step1", "step2", "step3", "step4"] as const;

const r2Rows = computed(() => [
  { field: t("dbBackups.s3.endpoint"), value: `https://${t("dbBackups.guide.accountId")}.r2.cloudflarestorage.com`, mono: true },
  { field: t("dbBackups.s3.region"), value: "auto", mono: true },
  { field: t("dbBackups.s3.bucket"), value: t("dbBackups.guide.bucketValue") },
  { field: t("dbBackups.s3.prefix"), value: "backups", mono: true },
  { field: t("dbBackups.s3.accessKeyId"), value: t("dbBackups.guide.fromToken") },
  { field: t("dbBackups.s3.secret"), value: t("dbBackups.guide.fromToken") },
  { field: t("dbBackups.s3.pathStyle"), value: t("dbBackups.guide.off") },
]);
</script>

<template>
  <UiModal :open="open" width="lg" :title="t('dbBackups.guide.title')" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-info h-8 w-8"><UiIcon name="book-open" :size="15" /></span>
    </template>

    <div class="space-y-6 text-sm">
      <p class="leading-relaxed text-fg-muted">{{ t("dbBackups.guide.intro") }}</p>

      <section>
        <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
          <span class="icon-chip icon-chip-warning h-6 w-6 rounded-md"><UiIcon name="globe" :size="12" /></span>
          {{ t("dbBackups.guide.r2.title") }}
        </h3>
        <ol class="space-y-2.5">
          <li v-for="(step, i) in r2Steps" :key="step" class="flex items-start gap-3">
            <span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 font-mono text-[10px] font-semibold text-accent">
              {{ i + 1 }}
            </span>
            <span class="min-w-0 text-xs leading-relaxed text-fg-muted">{{ t(`dbBackups.guide.r2.${step}`) }}</span>
          </li>
        </ol>
        <div class="mt-3 overflow-hidden rounded-xl border border-line">
          <table class="w-full text-xs">
            <thead>
              <tr class="bg-surface-2/60 text-left text-fg-muted dark:bg-surface-2/40">
                <th class="px-3 py-2 font-medium">{{ t("dbBackups.guide.fields") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("dbBackups.guide.value") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in r2Rows" :key="row.field" class="border-t border-line/60">
                <td class="whitespace-nowrap px-3 py-2 text-fg-muted">{{ row.field }}</td>
                <td class="break-all px-3 py-2 text-fg" :class="row.mono ? 'font-mono' : ''">{{ row.value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl border border-line bg-surface-2/40 p-3.5">
          <h3 class="mb-1.5 flex items-center gap-2 text-sm font-semibold text-fg">
            <UiIcon name="server" :size="14" class="text-fg-subtle" />
            {{ t("dbBackups.guide.aws.title") }}
          </h3>
          <p class="text-xs leading-relaxed text-fg-muted">{{ t("dbBackups.guide.aws.body") }}</p>
        </div>
        <div class="rounded-xl border border-line bg-surface-2/40 p-3.5">
          <h3 class="mb-1.5 flex items-center gap-2 text-sm font-semibold text-fg">
            <UiIcon name="box" :size="14" class="text-fg-subtle" />
            {{ t("dbBackups.guide.minio.title") }}
          </h3>
          <p class="text-xs leading-relaxed text-fg-muted">{{ t("dbBackups.guide.minio.body") }}</p>
        </div>
      </section>

      <p class="flex items-start gap-2 rounded-lg bg-success/[0.07] px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
        <UiIcon name="shield" :size="13" class="mt-px shrink-0 text-success" />
        {{ t("dbBackups.guide.tip") }}
      </p>
    </div>

    <template #footer>
      <button type="button" class="btn btn-primary" @click="emit('update:open', false)">{{ t("common.close") }}</button>
    </template>
  </UiModal>
</template>
