<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ChannelMonitor, UpstreamAccount } from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import FormField from "../../ui/FormField.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import UiSelect from "../../ui/UiSelect.vue";

const props = defineProps<{
  open: boolean;
  monitor: ChannelMonitor | null;
  accounts: UpstreamAccount[];
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "saved"): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const eligibleAccounts = computed(() =>
  props.accounts.filter((a) => a.executionMode !== "vm_slot"),
);

const saving = ref(false);
const form = reactive({
  name: "",
  description: "",
  accountId: "",
  model: "",
  intervalSeconds: 300,
  degradedLatencyMs: 8000,
  sortOrder: 0,
  enabled: true,
  isPublic: true,
});

watch(
  () => [props.open, props.monitor] as const,
  ([isOpen, mon]) => {
    if (!isOpen) return;
    if (mon) {
      form.name = mon.name;
      form.description = mon.description;
      form.accountId = mon.accountId;
      form.model = mon.model;
      form.intervalSeconds = mon.intervalSeconds;
      form.degradedLatencyMs = mon.degradedLatencyMs;
      form.sortOrder = mon.sortOrder;
      form.enabled = mon.enabled;
      form.isPublic = mon.isPublic;
    } else {
      form.name = "";
      form.description = "";
      form.accountId = eligibleAccounts.value[0]?.id ?? "";
      form.model = "";
      form.intervalSeconds = 300;
      form.degradedLatencyMs = 8000;
      form.sortOrder = 0;
      form.enabled = true;
      form.isPublic = true;
    }
  },
  { immediate: true },
);

async function submit() {
  saving.value = true;
  try {
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      accountId: form.accountId,
      model: form.model.trim(),
      intervalSeconds: Number(form.intervalSeconds),
      degradedLatencyMs: Number(form.degradedLatencyMs),
      sortOrder: Number(form.sortOrder),
      enabled: form.enabled,
      isPublic: form.isPublic,
    };
    if (props.monitor) {
      await apiJson(`/api/v1/admin/channel-monitors/${encodeURIComponent(props.monitor.id)}`, {
        method: "PATCH",
        body,
      });
    } else {
      await apiJson("/api/v1/admin/channel-monitors", { method: "POST", body });
    }
    toast.success(t("adminTools.monitor.synthetic.savedToast"));
    emit("update:open", false);
    emit("saved");
  } catch (err) {
    toast.error(errorText(err, t("adminTools.monitor.errors.saveSchedule")));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal
    :open="open"
    :title="monitor ? t('adminTools.monitor.synthetic.editTitle') : t('adminTools.monitor.synthetic.createTitle')"
    width="md"
    @update:open="emit('update:open', $event)"
  >
    <form class="space-y-4 p-5" @submit.prevent="submit">
      <FormField :label="t('adminTools.monitor.synthetic.form.name')">
        <input v-model="form.name" type="text" required class="input w-full" />
      </FormField>

      <FormField :label="t('adminTools.monitor.synthetic.form.description')">
        <input v-model="form.description" type="text" class="input w-full" />
      </FormField>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField :label="t('adminTools.monitor.synthetic.form.account')">
          <UiSelect v-model="form.accountId" required class="select w-full">
            <option v-for="acc in eligibleAccounts" :key="acc.id" :value="acc.id">
              {{ acc.name }} ({{ acc.platform }})
            </option>
          </UiSelect>
        </FormField>

        <FormField :label="t('adminTools.monitor.synthetic.form.model')">
          <input
            v-model="form.model"
            type="text"
            class="input w-full font-mono"
            :placeholder="t('adminTools.monitor.synthetic.form.modelPlaceholder')"
          />
        </FormField>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField :label="t('adminTools.monitor.synthetic.form.intervalSeconds')">
          <input v-model.number="form.intervalSeconds" type="number" min="30" max="86400" required class="input w-full" />
        </FormField>
        <FormField :label="t('adminTools.monitor.synthetic.form.degradedLatencyMs')">
          <input v-model.number="form.degradedLatencyMs" type="number" min="100" max="120000" required class="input w-full" />
        </FormField>
        <FormField :label="t('adminTools.monitor.synthetic.form.sortOrder')">
          <input v-model.number="form.sortOrder" type="number" min="-10000" max="10000" required class="input w-full" />
        </FormField>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-4 pt-2">
        <div class="flex items-center gap-4">
          <UiSwitch v-model="form.enabled" :label="t('adminTools.monitor.synthetic.form.enabled')" />
          <UiSwitch v-model="form.isPublic" :label="t('adminTools.monitor.synthetic.form.isPublic')" />
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">
            {{ t("common.cancel") }}
          </button>
          <button type="submit" class="btn btn-primary" :disabled="saving || !form.accountId">
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </form>
  </UiModal>
</template>
