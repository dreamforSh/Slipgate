<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { AuditClearRequest, AuditClearResponse } from "@slipgate/contracts";
import TotpStepUpModal from "./TotpStepUpModal.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson } from "../../../lib/api";
import { formatNumber } from "../../../lib/format";

/**
 * Wipes the whole audit log (Linksyncx AuditLogHandler.Clear): only with a fresh two-factor code,
 * checked on every call. Administrators without two-factor authentication are told to turn it on
 * first; a password is never accepted.
 */
withDefaults(defineProps<{ open: boolean; retentionDays?: number | null }>(), { retentionDays: null });
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "cleared", deleted: number): void }>();

const { t } = useI18n();

async function clear(totpCode: string) {
  const body: AuditClearRequest = { totpCode };
  const { deleted } = await apiJson<AuditClearResponse>("/api/v1/admin/audit-logs/clear", {
    method: "POST",
    body,
    fallbackError: t("audit.errors.clear"),
  });
  emit("cleared", deleted);
}
</script>

<template>
  <TotpStepUpModal
    :open="open"
    :title="t('audit.clear.title')"
    icon="trash"
    :submit-label="t('audit.clear.submit')"
    :pending-label="t('audit.clear.clearing')"
    :fallback-error="t('audit.errors.clear')"
    :action="clear"
    @update:open="emit('update:open', $event)"
  >
    <UiAlert tone="danger">{{ t("audit.clear.warning") }}</UiAlert>
    <p v-if="retentionDays && retentionDays > 0" class="flex items-start gap-2 text-xs leading-relaxed text-fg-subtle">
      <UiIcon name="clock" :size="13" class="mt-px shrink-0" />
      {{ t("audit.clear.retentionNote", { n: formatNumber(retentionDays) }, retentionDays) }}
    </p>
  </TotpStepUpModal>
</template>
