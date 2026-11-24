<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UserAttributeDefinition, UserAttributeType } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";

const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "changed"): void }>();

const { t } = useI18n();
const toast = useToastStore();

const defs = ref<UserAttributeDefinition[]>([]);
const loading = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);
const confirmDeleteId = ref<string | null>(null);

const TYPE_OPTIONS: UserAttributeType[] = ["text", "number", "select", "multiselect", "date", "url"];

const form = reactive({
  key: "",
  name: "",
  description: "",
  type: "text" as UserAttributeType,
  optionsText: "",
  required: false,
  enabled: true,
  sortOrder: 0,
});

function resetForm() {
  editingId.value = null;
  Object.assign(form, {
    key: "",
    name: "",
    description: "",
    type: "text" as UserAttributeType,
    optionsText: "",
    required: false,
    enabled: true,
    sortOrder: 0,
  });
}

function startEdit(def: UserAttributeDefinition) {
  editingId.value = def.id;
  Object.assign(form, {
    key: def.key,
    name: def.name,
    description: def.description,
    type: def.type,
    optionsText: def.options.join(", "),
    required: def.required,
    enabled: def.enabled,
    sortOrder: def.sortOrder,
  });
}

async function load() {
  loading.value = true;
  try {
    const res = await apiJson<{ items: UserAttributeDefinition[] }>("/api/v1/admin/user-attributes");
    defs.value = res.items;
  } catch (err) {
    toast.error(errorText(err, t("adminUsers.attributes.loadError")));
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (saving.value) return;
  saving.value = true;
  try {
    const options = form.optionsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (editingId.value) {
      await apiJson(`/api/v1/admin/user-attributes/${encodeURIComponent(editingId.value)}`, {
        method: "PATCH",
        body: {
          name: form.name.trim(),
          description: form.description.trim(),
          type: form.type,
          options,
          required: form.required,
          enabled: form.enabled,
          sortOrder: Number.isFinite(Number(form.sortOrder)) ? Math.trunc(Number(form.sortOrder)) : 0,
        },
      });
    } else {
      await apiJson("/api/v1/admin/user-attributes", {
        method: "POST",
        body: {
          key: form.key.trim().toLowerCase(),
          name: form.name.trim(),
          description: form.description.trim(),
          type: form.type,
          options,
          required: form.required,
          enabled: form.enabled,
          sortOrder: Number.isFinite(Number(form.sortOrder)) ? Math.trunc(Number(form.sortOrder)) : 0,
        },
      });
    }
    toast.success(t("common.saved"));
    resetForm();
    await load();
    emit("changed");
  } catch (err) {
    toast.error(errorText(err, t("adminUsers.attributes.saveError")));
  } finally {
    saving.value = false;
  }
}

async function removeDef(id: string) {
  if (confirmDeleteId.value !== id) {
    confirmDeleteId.value = id;
    return;
  }
  try {
    await apiJson(`/api/v1/admin/user-attributes/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast.success(t("common.deleted"));
    confirmDeleteId.value = null;
    if (editingId.value === id) resetForm();
    await load();
    emit("changed");
  } catch (err) {
    toast.error(errorText(err, t("adminUsers.attributes.deleteError")));
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    resetForm();
    void load();
  }
});
</script>

<template>
  <UiModal v-model:open="open" width="lg" :title="t('adminUsers.attributes.manageTitle')">
    <div class="space-y-5">
      <div v-if="loading && defs.length === 0" class="py-4 text-center text-xs text-fg-subtle">
        {{ t("common.loading") }}
      </div>
      <div v-else-if="defs.length > 0" class="divide-y divide-line/70 rounded-xl border border-line bg-surface-2/20 px-4">
        <div v-for="d in defs" :key="d.id" class="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-fg">{{ d.name }}</span>
              <code class="font-mono text-2xs text-fg-subtle">{{ d.key }}</code>
              <UiBadge tone="info">{{ t(`adminUsers.attributes.types.${d.type}`) }}</UiBadge>
              <UiBadge v-if="d.required" tone="warning">{{ t("adminUsers.attributes.required") }}</UiBadge>
              <UiBadge v-if="!d.enabled" tone="neutral">{{ t("common.disabled") }}</UiBadge>
            </div>
            <p v-if="d.description" class="mt-0.5 text-2xs text-fg-subtle">{{ d.description }}</p>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn btn-secondary btn-sm" @click="startEdit(d)">
              <UiIcon name="pencil" :size="12" />
              {{ t("common.edit") }}
            </button>
            <button
              type="button"
              class="btn btn-sm"
              :class="confirmDeleteId === d.id ? 'btn-danger' : 'btn-secondary'"
              @click="removeDef(d.id)"
            >
              <UiIcon name="trash" :size="12" />
              {{ confirmDeleteId === d.id ? t("common.confirmDelete") : t("common.delete") }}
            </button>
          </div>
        </div>
      </div>

      <form class="space-y-3 rounded-xl border border-line bg-surface-2/30 p-4" @submit.prevent="submit">
        <div class="flex items-center justify-between">
          <p class="text-sm font-semibold text-fg">
            {{ editingId ? t("adminUsers.attributes.editTitle") : t("adminUsers.attributes.createTitle") }}
          </p>
          <button v-if="editingId" type="button" class="text-xs text-fg-subtle hover:text-fg" @click="resetForm">
            {{ t("common.cancel") }}
          </button>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <FormField :label="t('adminUsers.attributes.fields.key')" required>
            <input
              v-model="form.key"
              type="text"
              required
              :disabled="Boolean(editingId)"
              pattern="^[a-z][a-z0-9_]*$"
              placeholder="company_name"
              class="input font-mono"
            />
          </FormField>
          <FormField :label="t('adminUsers.attributes.fields.name')" required>
            <input v-model="form.name" type="text" required maxlength="80" class="input" />
          </FormField>
          <FormField :label="t('adminUsers.attributes.fields.type')">
            <select v-model="form.type" class="select">
              <option v-for="tp in TYPE_OPTIONS" :key="tp" :value="tp">
                {{ t(`adminUsers.attributes.types.${tp}`) }}
              </option>
            </select>
          </FormField>
          <FormField :label="t('adminUsers.attributes.fields.sortOrder')">
            <input v-model.number="form.sortOrder" type="number" class="input font-mono" />
          </FormField>
        </div>
        <FormField
          v-if="form.type === 'select' || form.type === 'multiselect'"
          :label="t('adminUsers.attributes.fields.options')"
          :hint="t('adminUsers.attributes.fields.optionsHint')"
          required
        >
          <input v-model="form.optionsText" type="text" required class="input" placeholder="Option A, Option B" />
        </FormField>
        <FormField :label="t('adminUsers.attributes.fields.description')">
          <input v-model="form.description" type="text" maxlength="400" class="input" />
        </FormField>
        <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div class="flex flex-wrap gap-4 text-xs">
            <label class="inline-flex cursor-pointer items-center gap-1.5">
              <input v-model="form.required" type="checkbox" class="rounded border-line text-accent" />
              <span>{{ t("adminUsers.attributes.required") }}</span>
            </label>
            <label class="inline-flex cursor-pointer items-center gap-1.5">
              <input v-model="form.enabled" type="checkbox" class="rounded border-line text-accent" />
              <span>{{ t("common.enabled") }}</span>
            </label>
          </div>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="saving">
            <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
            {{ editingId ? t("common.save") : t("common.add") }}
          </button>
        </div>
      </form>
    </div>
  </UiModal>
</template>
