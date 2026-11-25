<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UpstreamAccount } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSelect from "../../ui/UiSelect.vue";
import { executionModeLabel } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ExitNodePicker from "./ExitNodePicker.vue";
import { modeUsesExit, type ExitPool } from "./exitPool";

/** Change one account's exit proxy (and its TLS profile) straight from the account list. */
const props = defineProps<{
  open: boolean;
  account: UpstreamAccount | null;
  pool: ExitPool;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "saved"): void }>();

const { t } = useI18n();
const toast = useToastStore();

const nodeId = ref("");
const profileId = ref("");
const saving = ref(false);

const current = computed(() => (props.account ? (props.pool.bindingByAccount.get(props.account.id) ?? null) : null));
const needsExit = computed(() => !!props.account && modeUsesExit(props.account.executionMode));
const changed = computed(
  () => nodeId.value !== (current.value?.nodeId ?? "") || (nodeId.value !== "" && profileId.value !== (current.value?.utlsProfileId ?? "")),
);

watch(
  () => (props.open ? (props.account?.id ?? "") : null),
  (key) => {
    if (key === null) return;
    nodeId.value = current.value?.nodeId ?? "";
    profileId.value = current.value?.utlsProfileId ?? "";
  },
  { immediate: true },
);

async function save() {
  const acc = props.account;
  if (!acc || saving.value || !changed.value) return;
  saving.value = true;
  try {
    const err = nodeId.value ? await props.pool.bind(acc.id, nodeId.value, profileId.value) : await props.pool.unbind(acc.id);
    if (err) {
      toast.error(t("accounts.exitPicker.saveFailed", { message: err }));
      return;
    }
    await props.pool.load();
    toast.success(nodeId.value ? t("accounts.exitPicker.bound", { name: acc.name }) : t("accounts.exitPicker.unbound", { name: acc.name }));
    emit("saved");
    emit("update:open", false);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" :title="t('accounts.exitPicker.title')" width="md" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="network" :size="15" /></span>
    </template>

    <div v-if="account" class="space-y-4">
      <p class="text-xs text-fg-muted">
        {{ t("accounts.exitPicker.forAccount", { name: account.name, mode: executionModeLabel(account.executionMode) }) }}
      </p>
      <UiAlert v-if="pool.standalone" tone="info">{{ t("accounts.form.exit.standalone") }}</UiAlert>
      <ExitNodePicker v-model="nodeId" :pool="pool" :current="current" :disabled="pool.standalone" />
      <div v-if="nodeId">
        <label class="label" for="account-exit-profile">{{ t("accounts.form.exit.profile") }}</label>
        <UiSelect id="account-exit-profile" v-model="profileId" class="select">
          <option value="">{{ t("accounts.form.exit.profileDefault") }}</option>
          <option v-for="p in pool.profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
        </UiSelect>
      </div>
      <UiAlert v-if="needsExit && !nodeId" tone="warning">
        {{ t("accounts.form.exit.requiredHint", { mode: executionModeLabel(account.executionMode) }) }}
      </UiAlert>
      <p v-else-if="!needsExit" class="text-2xs text-fg-subtle">{{ t("accounts.form.exit.directHint") }}</p>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="button" class="btn btn-primary" :disabled="saving || !changed || pool.standalone" @click="save">
        <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
        {{ nodeId || !current ? t("accounts.exitPicker.save") : t("accounts.exitPicker.unbind") }}
      </button>
    </template>
  </UiModal>
</template>
