<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UserAttributeValueItem } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import UiSelect from "../../ui/UiSelect.vue";

const props = withDefaults(
  defineProps<{
    /** When provided, reads/writes via /api/v1/admin/users/:userId/attributes; otherwise /api/v1/user/attributes. */
    userId?: string;
    active?: boolean;
  }>(),
  { userId: undefined, active: true },
);

const emit = defineEmits<{ (e: "loaded", count: number): void }>();

const { t } = useI18n();
const toast = useToastStore();

const items = ref<UserAttributeValueItem[]>([]);
const drafts = reactive<Record<string, string>>({});
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

function endpoint(): string {
  return props.userId
    ? `/api/v1/admin/users/${encodeURIComponent(props.userId)}/attributes`
    : "/api/v1/user/attributes";
}

function parseMulti(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toggleMulti(attrId: string, option: string) {
  const cur = parseMulti(drafts[attrId]);
  const next = cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option];
  drafts[attrId] = next.length ? JSON.stringify(next) : "";
}

async function load() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<{ items: UserAttributeValueItem[] }>(endpoint(), {
      fallbackError: t("adminUsers.attributes.loadError"),
    });
    items.value = res.items;
    for (const k of Object.keys(drafts)) delete drafts[k];
    for (const it of res.items) drafts[it.attributeId] = it.value;
    emit("loaded", res.items.length);
  } catch (err) {
    errorMessage.value = errorText(err, t("adminUsers.attributes.loadError"));
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value || items.value.length === 0) return;
  saving.value = true;
  try {
    const payload: Record<string, string> = {};
    for (const it of items.value) {
      if (!props.userId && !it.enabled) continue;
      payload[it.attributeId] = drafts[it.attributeId] ?? "";
    }
    const res = await apiJson<{ items: UserAttributeValueItem[] }>(endpoint(), {
      method: "PUT",
      body: { values: payload },
      fallbackError: t("adminUsers.attributes.saveError"),
    });
    items.value = res.items;
    for (const it of res.items) drafts[it.attributeId] = it.value;
    toast.success(t("common.saved"));
  } catch (err) {
    toast.error(errorText(err, t("adminUsers.attributes.saveError")));
  } finally {
    saving.value = false;
  }
}

watch(
  () => [props.userId, props.active] as const,
  ([, isActive]) => {
    if (isActive !== false) void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="space-y-4">
    <p v-if="errorMessage" class="text-xs text-danger">{{ errorMessage }}</p>
    <p v-else-if="loading && items.length === 0" class="py-4 text-center text-xs text-fg-subtle">
      {{ t("common.loading") }}
    </p>
    <p v-else-if="items.length === 0" class="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-fg-subtle">
      {{ t("adminUsers.attributes.emptyValues") }}
    </p>

    <form v-else class="space-y-4" @submit.prevent="save">
      <div v-for="it in items" :key="it.attributeId" class="space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <label :for="`attr-${it.attributeId}`" class="label mb-0">
            {{ it.name }}
            <span v-if="it.required" class="text-danger">*</span>
          </label>
          <div class="flex items-center gap-1.5">
            <code class="font-mono text-2xs text-fg-subtle">{{ it.key }}</code>
            <UiBadge v-if="!it.enabled" tone="neutral">{{ t("common.disabled") }}</UiBadge>
          </div>
        </div>

        <UiSelect
          v-if="it.type === 'select'"
          :id="`attr-${it.attributeId}`"
          v-model="drafts[it.attributeId]"
          :required="it.required && !userId"
          class="select"
        >
          <option value="">{{ t("common.none") }}</option>
          <option v-for="opt in it.options" :key="opt" :value="opt">{{ opt }}</option>
        </UiSelect>

        <div
          v-else-if="it.type === 'multiselect'"
          class="flex flex-wrap gap-1.5 rounded-lg border border-line bg-surface-2/40 p-2"
        >
          <button
            v-for="opt in it.options"
            :key="opt"
            type="button"
            class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors"
            :class="
              parseMulti(drafts[it.attributeId]).includes(opt)
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-line bg-surface text-fg-muted hover:text-fg'
            "
            @click="toggleMulti(it.attributeId, opt)"
          >
            <UiIcon :name="parseMulti(drafts[it.attributeId]).includes(opt) ? 'check' : 'plus'" :size="12" />
            <span>{{ opt }}</span>
          </button>
        </div>

        <input
          v-else
          :id="`attr-${it.attributeId}`"
          v-model="drafts[it.attributeId]"
          :type="it.type === 'number' ? 'number' : it.type === 'date' ? 'date' : it.type === 'url' ? 'url' : 'text'"
          :step="it.type === 'number' ? 'any' : undefined"
          :required="it.required && !userId"
          class="input"
          :class="it.type !== 'text' ? 'font-mono' : ''"
        />

        <p v-if="it.description" class="text-2xs text-fg-subtle">{{ it.description }}</p>
      </div>

      <div class="flex justify-end border-t border-line/70 pt-3">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="saving">
          <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
          {{ saving ? t("common.saving") : t("common.save") }}
        </button>
      </div>
    </form>
  </div>
</template>
