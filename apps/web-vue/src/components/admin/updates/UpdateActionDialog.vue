<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { AdminStepUp } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { isPasskeyCancellation, usePasskeyStepUp } from "../../../composables/usePasskeyStepUp";
import { errorText } from "../../../lib/api";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import BackupStepUpFields from "../db-backups/BackupStepUpFields.vue";
import { useBackupStepUp } from "../db-backups/useBackupStepUp";

export interface UpdateActionSummary {
  icon: IconName;
  /** Label / value pairs, e.g. current → target version. */
  rows: { label: string; value: string; accent?: boolean }[];
  /** What happens once the action is accepted (restart, drain window …). */
  effects: string[];
  /** Highlighted caution, e.g. in-flight streams cut after the drain window. */
  caution?: string;
}

/**
 * Confirms an update-center action (apply, install, rollback, restart, policy change) with a
 * summary of its effects. Release deployments also ask for the password (plus the authenticator
 * code when two-factor sign-in is on) or one of the admin's passkeys; dev deployments confirm with
 * one click. `submit` resolves once the request is accepted; a refusal of the password or code
 * stays on that field.
 */
const props = defineProps<{
  title: string;
  confirmLabel: string;
  summary: UpdateActionSummary | null;
  requireStepUp: boolean;
  submit: (confirm: AdminStepUp | undefined) => Promise<void>;
}>();
const open = defineModel<boolean>("open", { required: true });

const { t } = useI18n();
const stepUp = useBackupStepUp();
const passkey = usePasskeyStepUp();
const busy = ref(false);
/** The pending confirmation came from the passkey button (it shows the spinner then). */
const viaPasskey = ref(false);
const fields = ref<InstanceType<typeof BackupStepUpFields> | null>(null);

watch(open, (isOpen) => {
  busy.value = false;
  viaPasskey.value = false;
  if (isOpen && props.requireStepUp) {
    stepUp.reset();
    void passkey.refresh();
  } else {
    stepUp.dispose();
    passkey.dispose();
  }
});

const canSubmit = computed(() => !busy.value && (!props.requireStepUp || stepUp.ready.value));
const showPasskey = computed(() => props.requireStepUp && passkey.available.value);

/** Obtains the confirmation (password fields or passkey), then submits it. */
async function run(obtain: () => Promise<AdminStepUp | undefined>, withPasskey: boolean) {
  busy.value = true;
  viaPasskey.value = withPasskey;
  stepUp.clearErrors();
  try {
    let confirmation: AdminStepUp | undefined;
    try {
      confirmation = await obtain();
    } catch (err) {
      stepUp.formError.value = isPasskeyCancellation(err)
        ? t("updates.confirm.passkeyCancelled")
        : errorText(err, t("updates.confirm.passkeyFailed"));
      return;
    }
    await props.submit(confirmation);
    open.value = false;
  } catch (err) {
    if (!props.requireStepUp || !stepUp.absorb(err)) {
      stepUp.formError.value = errorText(err, t("common.requestFailed"));
    }
    if (stepUp.codeError.value) {
      await nextTick();
      fields.value?.focusCode();
    }
  } finally {
    busy.value = false;
    viaPasskey.value = false;
  }
}

function confirm() {
  if (!canSubmit.value) return;
  void run(async () => (props.requireStepUp ? stepUp.payload() : undefined), false);
}

function confirmWithPasskey() {
  if (busy.value) return;
  void run(async () => ({ passkeyStepUpToken: await passkey.confirm() }), true);
}
</script>

<template>
  <UiModal v-model:open="open" width="md" :title="title" :persistent="busy">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="summary?.icon ?? 'refresh'" :size="15" />
      </span>
    </template>

    <form id="update-action-form" class="space-y-4" novalidate @submit.prevent="confirm">
      <div v-if="summary" class="space-y-3 rounded-xl border border-line bg-surface-2/50 p-3.5">
        <dl class="space-y-1.5 text-xs">
          <div v-for="row in summary.rows" :key="row.label" class="flex items-center justify-between gap-3">
            <dt class="text-fg-subtle">{{ row.label }}</dt>
            <dd class="truncate font-mono" :class="row.accent ? 'font-semibold text-accent' : 'text-fg'">
              {{ row.value }}
            </dd>
          </div>
        </dl>
        <ul v-if="summary.effects.length" class="space-y-1 border-t border-line pt-2.5 text-xs leading-relaxed text-fg-muted">
          <li v-for="effect in summary.effects" :key="effect" class="flex items-start gap-1.5">
            <UiIcon name="check" :size="12" class="mt-0.5 shrink-0 text-fg-subtle" />
            <span>{{ effect }}</span>
          </li>
        </ul>
      </div>

      <UiAlert v-if="summary?.caution" tone="warning">
        <span class="text-xs">{{ summary.caution }}</span>
      </UiAlert>

      <template v-if="requireStepUp">
        <p class="flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
          <UiIcon name="lock" :size="13" class="mt-px shrink-0 text-fg-subtle" />
          {{ t("updates.confirm.stepUpIntro", { totp: stepUp.needTotp.value ? t("security.stepUp.introTotp") : "" }) }}
        </p>
        <BackupStepUpFields
          ref="fields"
          v-model:password="stepUp.password.value"
          v-model:code="stepUp.code.value"
          id-prefix="update-action-step-up"
          :need-totp="stepUp.needTotp.value"
          :checking="stepUp.checking.value"
          :disabled="busy"
          :password-error="stepUp.passwordError.value"
          :code-error="stepUp.codeError.value"
          @complete="confirm"
        />
        <template v-if="showPasskey">
          <div class="flex items-center gap-3" aria-hidden="true">
            <span class="h-px flex-1 bg-line" />
            <span class="text-2xs text-fg-subtle">{{ t("updates.confirm.passkeyOr") }}</span>
            <span class="h-px flex-1 bg-line" />
          </div>
          <button type="button" class="btn btn-secondary w-full" :disabled="busy" @click="confirmWithPasskey">
            <UiIcon :name="viaPasskey ? 'loader' : 'fingerprint'" :size="15" :spin="viaPasskey" />
            {{ viaPasskey ? t("updates.confirm.passkeyWorking") : t("updates.confirm.passkeyButton") }}
          </button>
        </template>
      </template>
      <p v-else class="flex items-center gap-1.5 text-2xs text-fg-subtle">
        <UiIcon name="unlock" :size="12" />
        {{ t("updates.confirm.noStepUp") }}
      </p>

      <UiAlert v-if="stepUp.formError.value" tone="danger">{{ stepUp.formError.value }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
      <!-- One-click confirmation focuses the button; with step-up the password field gets focus. -->
      <button
        type="submit"
        form="update-action-form"
        class="btn btn-primary"
        :disabled="!canSubmit"
        :autofocus="!requireStepUp || undefined"
      >
        <UiIcon
          :name="busy && !viaPasskey ? 'loader' : requireStepUp ? 'shield' : (summary?.icon ?? 'check')"
          :size="15"
          :spin="busy && !viaPasskey"
        />
        {{ busy && !viaPasskey ? t("updates.confirm.working") : confirmLabel }}
      </button>
    </template>
  </UiModal>
</template>
