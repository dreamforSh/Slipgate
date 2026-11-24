<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminStepUp } from "@slipgate/contracts";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import { errorText } from "../../lib/api";
import BackupStepUpFields from "./db-backups/BackupStepUpFields.vue";
import { useBackupStepUp } from "./db-backups/useBackupStepUp";

/**
 * Re-confirmation for a change that could hand the deployment over (an administrator account,
 * another user's password or second factor, the backup target): the password, plus the
 * authenticator code when two-factor sign-in is on. `action` runs with it; a refusal about the
 * password or code stays on that field, any other error is shown here and the dialog stays open.
 */
const props = defineProps<{
  title: string;
  action: (confirm: AdminStepUp) => Promise<void>;
}>();
const open = defineModel<boolean>("open", { required: true });

const { t } = useI18n();
const stepUp = useBackupStepUp();
const busy = ref(false);
const fields = ref<InstanceType<typeof BackupStepUpFields> | null>(null);

watch(open, (isOpen) => {
  busy.value = false;
  if (isOpen) stepUp.reset();
  else stepUp.dispose();
});

const canSubmit = computed(() => !busy.value && stepUp.ready.value);

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  stepUp.clearErrors();
  try {
    await props.action(stepUp.payload());
    open.value = false;
  } catch (err) {
    if (!stepUp.absorb(err)) stepUp.formError.value = errorText(err, t("common.requestFailed"));
    if (stepUp.codeError.value) {
      await nextTick();
      fields.value?.focusCode();
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" width="md" :title="title" :persistent="busy">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="shield" :size="15" /></span>
    </template>

    <form id="admin-step-up-form" class="space-y-4" novalidate @submit.prevent="submit">
      <p class="flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
        <UiIcon name="lock" :size="13" class="mt-px shrink-0 text-fg-subtle" />
        {{ t("security.stepUp.intro", { totp: stepUp.needTotp.value ? t("security.stepUp.introTotp") : "" }) }}
      </p>
      <BackupStepUpFields
        ref="fields"
        v-model:password="stepUp.password.value"
        v-model:code="stepUp.code.value"
        id-prefix="admin-step-up"
        :need-totp="stepUp.needTotp.value"
        :checking="stepUp.checking.value"
        :disabled="busy"
        :password-error="stepUp.passwordError.value"
        :code-error="stepUp.codeError.value"
        @complete="submit"
      />
      <UiAlert v-if="stepUp.formError.value" tone="danger">{{ stepUp.formError.value }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
      <button type="submit" form="admin-step-up-form" class="btn btn-primary" :disabled="!canSubmit">
        <UiIcon :name="busy ? 'loader' : 'shield'" :size="15" :spin="busy" />
        {{ busy ? t("security.stepUp.working") : t("security.stepUp.confirm") }}
      </button>
    </template>
  </UiModal>
</template>
