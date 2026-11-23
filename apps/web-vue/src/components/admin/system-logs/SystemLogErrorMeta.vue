<script setup lang="ts">
import { useI18n } from "vue-i18n";
import CopyButton from "../../ui/CopyButton.vue";
import type { ErrorInfo } from "./systemLogUtil";

/**
 * Secondary lines under a localized error: the failed call's request ID (to find its own system
 * log entries) and the server's raw text.
 */
defineProps<{ error: ErrorInfo }>();

const { t } = useI18n();
</script>

<template>
  <span v-if="error.requestId || error.detail" class="mt-1 flex min-w-0 flex-col gap-0.5 text-2xs text-fg-subtle">
    <span v-if="error.requestId" class="flex min-w-0 items-center gap-1">
      <span class="shrink-0">{{ t("systemLogs.requestIdLabel") }}</span>
      <span class="truncate font-mono">{{ error.requestId }}</span>
      <CopyButton :text="error.requestId" />
    </span>
    <span v-if="error.detail" class="min-w-0 break-words">
      <span>{{ t("systemLogs.errors.detail") }}</span>
      <span class="ml-1 font-mono">{{ error.detail }}</span>
    </span>
  </span>
</template>
