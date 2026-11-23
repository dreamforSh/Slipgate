<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountExportFile } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";

/** Download a Slipgate account backup (plaintext credentials) after re-entering the password. */
const props = defineProps<{
  open: boolean;
  selectedIds: string[];
  totalCount: number;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

type Scope = "selected" | "all";
const scope = ref<Scope>("all");
const password = ref("");
const totpCode = ref("");
const totpNeeded = ref(false);
const exporting = ref(false);
const error = ref<string | null>(null);

const needsTotp = computed(() => Boolean(auth.user?.totpEnabled) || totpNeeded.value);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      password.value = "";
      totpCode.value = "";
      totpNeeded.value = false;
      return;
    }
    scope.value = props.selectedIds.length ? "selected" : "all";
    error.value = null;
  },
);

const count = computed(() => (scope.value === "selected" ? props.selectedIds.length : props.totalCount));

function download(file: AccountExportFile) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slipgate-accounts-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function submit() {
  if (!password.value || (needsTotp.value && totpCode.value.trim().length !== 6) || exporting.value || count.value === 0) return;
  exporting.value = true;
  error.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/accounts/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: password.value,
        totpCode: totpCode.value.trim() || undefined,
        accountIds: scope.value === "selected" ? props.selectedIds : undefined,
      }),
    });
    if (res.status === 403) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (data.error === "totp_required" || data.error === "invalid_totp") {
        totpNeeded.value = true;
        error.value = data.message ?? t("accounts.errors.exportFailed");
      } else {
        error.value = data.error === "invalid_password" ? t("accounts.export.invalidPassword") : (data.message ?? t("accounts.export.invalidPassword"));
      }
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      error.value = data.message ?? t("accounts.errors.exportFailed");
      return;
    }
    const file = (await res.json()) as AccountExportFile;
    download(file);
    toast.success(t("accounts.export.done", { count: file.accounts.length }));
    if (file.skipped.length) toast.warning(t("accounts.export.skipped", { count: file.skipped.length }));
    emit("update:open", false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : t("accounts.errors.exportFailed");
  } finally {
    exporting.value = false;
    password.value = "";
    totpCode.value = "";
  }
}
</script>

<template>
  <UiModal :open="open" :title="t('accounts.export.title')" width="md" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-warning h-8 w-8"><UiIcon name="download" :size="16" /></span>
    </template>
    <form id="account-export-form" class="space-y-4" @submit.prevent="submit">
      <UiAlert tone="warning">{{ t("accounts.export.warning") }}</UiAlert>

      <fieldset class="space-y-2">
        <legend class="label">{{ t("accounts.export.scope") }}</legend>
        <label
          class="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors"
          :class="[
            scope === 'selected' ? 'bg-accent/[0.06] ring-1 ring-inset ring-accent/25' : 'bg-surface-2/50',
            selectedIds.length ? '' : 'cursor-not-allowed opacity-50',
          ]"
        >
          <input v-model="scope" type="radio" value="selected" class="checkbox" :disabled="!selectedIds.length" />
          {{ t("accounts.export.scopeSelected", { count: selectedIds.length }) }}
        </label>
        <label
          class="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors"
          :class="scope === 'all' ? 'bg-accent/[0.06] ring-1 ring-inset ring-accent/25' : 'bg-surface-2/50'"
        >
          <input v-model="scope" type="radio" value="all" class="checkbox" />
          {{ t("accounts.export.scopeAll", { count: totalCount }) }}
        </label>
      </fieldset>

      <label class="block">
        <span class="label">{{ t("accounts.export.password") }} <span class="text-danger">*</span></span>
        <input v-model="password" type="password" required autocomplete="current-password" class="input" />
        <span class="mt-1 block text-2xs text-fg-subtle">{{ t("accounts.export.passwordHint") }}</span>
      </label>
      <label v-if="needsTotp" class="block">
        <span class="label">2FA Code <span class="text-danger">*</span></span>
        <input
          v-model="totpCode"
          type="text"
          inputmode="numeric"
          pattern="\d{6}"
          maxlength="6"
          required
          autocomplete="one-time-code"
          class="input font-mono tracking-widest"
        />
      </label>
      <p v-if="error" class="text-sm text-danger">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button
        type="submit"
        form="account-export-form"
        class="btn btn-primary"
        :disabled="exporting || !password || (needsTotp && totpCode.trim().length !== 6) || count === 0"
      >
        <UiIcon :name="exporting ? 'loader' : 'download'" :size="14" :spin="exporting" />
        {{ exporting ? t("accounts.export.exporting") : t("accounts.export.submit") }}
      </button>
    </template>
  </UiModal>
</template>
