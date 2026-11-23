<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { AssignSubscriptionRequest, GroupItem, UserSubscriptionItem } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { formatUsd } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import EmailChipsInput from "./EmailChipsInput.vue";
import { CAP_WINDOWS, type CapWindow } from "./subscriptionDisplay";

/**
 * Assign (or extend) a subscription group for many users by email. Per-user failures come
 * back in `failed`; those emails stay in the field so they can be fixed and resubmitted.
 */
const props = defineProps<{ groups: GroupItem[] }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "assigned", items: UserSubscriptionItem[]): void }>();

const { t } = useI18n();
const auth = useAuthStore();

const groupId = ref("");
const validityDays = ref(30);
const emails = ref<string[]>([]);
const notes = ref("");
const saving = ref(false);
const error = ref<string | null>(null);
const failed = ref<{ user: string; message: string }[]>([]);
const chips = ref<InstanceType<typeof EmailChipsInput> | null>(null);

const group = computed(() => props.groups.find((g) => g.id === groupId.value) ?? null);

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  failed.value = [];
  emails.value = [];
  notes.value = "";
  chips.value?.reset();
  const first = props.groups.find((g) => g.enabled) ?? props.groups[0];
  groupId.value = first?.id ?? "";
  validityDays.value = first?.defaultValidityDays ?? 30;
});

watch(groupId, () => {
  if (group.value) validityDays.value = group.value.defaultValidityDays;
});

const LIMIT_KEY: Record<CapWindow, "dailyLimitNanoUsd" | "weeklyLimitNanoUsd" | "monthlyLimitNanoUsd"> = {
  daily: "dailyLimitNanoUsd",
  weekly: "weeklyLimitNanoUsd",
  monthly: "monthlyLimitNanoUsd",
};

const caps = computed(() => {
  const g = group.value;
  if (!g) return [];
  return CAP_WINDOWS.map((w) => ({ key: w, nano: g[LIMIT_KEY[w]] })).filter((c) => c.nano !== "0" && /^\d+$/.test(c.nano));
});

const validDays = computed(() => Number.isInteger(validityDays.value) && validityDays.value >= 1 && validityDays.value <= 3650);
const canSubmit = computed(() => !saving.value && Boolean(group.value) && validDays.value);

async function submit() {
  chips.value?.flush();
  if (!canSubmit.value) return;
  if (emails.value.length === 0) {
    error.value = t("subscriptions.assign.noUsers");
    return;
  }
  error.value = null;
  failed.value = [];
  saving.value = true;
  try {
    const body: AssignSubscriptionRequest = {
      userIds: [],
      emails: [...emails.value],
      groupId: groupId.value,
      validityDays: validityDays.value,
      notes: notes.value.trim(),
    };
    // The endpoint answers 400 with `failed` when nobody could be assigned, so read the body ourselves.
    const res = await auth.apiFetch("/api/v1/admin/subscriptions/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    type AssignBody = {
      items?: UserSubscriptionItem[];
      failed?: { user: string; message: string }[];
      message?: string;
      error?: string;
    };
    let data: AssignBody | null = null;
    try {
      const raw = await res.text();
      data = raw ? (JSON.parse(raw) as AssignBody) : null;
    } catch {
      data = null;
    }
    if (!res.ok && (!data || !Array.isArray(data.failed))) {
      error.value = data?.message || data?.error || t("subscriptions.errors.assign");
      return;
    }
    const items = data?.items ?? [];
    failed.value = data?.failed ?? [];
    if (items.length > 0) emit("assigned", items);
    if (failed.value.length === 0) {
      open.value = false;
    } else {
      // Keep only the addresses that still need attention.
      const keep = new Set(failed.value.map((f) => f.user.toLowerCase()));
      emails.value = emails.value.filter((e) => keep.has(e.toLowerCase()));
    }
  } catch (err) {
    error.value = err instanceof Error && err.message ? err.message : t("subscriptions.errors.assign");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" width="lg" :persistent="saving" :title="t('subscriptions.assign.title')">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon name="badge-check" :size="15" />
      </span>
    </template>

    <UiAlert v-if="groups.length === 0" tone="warning">
      {{ t("subscriptions.assign.noGroups") }}
      <template #action>
        <RouterLink to="/admin/groups" class="btn btn-secondary btn-xs shrink-0" @click="open = false">
          {{ t("subscriptions.list.goGroups") }}
        </RouterLink>
      </template>
    </UiAlert>

    <form v-else id="subscription-assign" class="grid gap-4 sm:grid-cols-2" @submit.prevent="submit">
      <UiAlert v-if="error" tone="danger" class="animate-fade-in sm:col-span-2">{{ error }}</UiAlert>
      <UiAlert
        v-if="failed.length"
        tone="warning"
        class="animate-fade-in sm:col-span-2"
        :title="t('subscriptions.assign.failedTitle', { n: failed.length })"
      >
        <ul class="max-h-32 space-y-0.5 overflow-y-auto text-xs">
          <li v-for="f in failed" :key="f.user" class="flex flex-wrap gap-x-2">
            <span class="font-mono text-fg">{{ f.user }}</span>
            <span class="text-fg-muted">{{ f.message }}</span>
          </li>
        </ul>
        <p class="mt-1.5 text-xs text-fg-subtle">{{ t("subscriptions.assign.failedHint") }}</p>
      </UiAlert>

      <FormField :label="t('subscriptions.assign.group')" required>
        <select v-model="groupId" required class="select">
          <option value="" disabled>{{ t("subscriptions.assign.groupPlaceholder") }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">
            {{ g.name }}{{ g.enabled ? "" : ` · ${t("common.disabled")}` }}
          </option>
        </select>
      </FormField>
      <FormField :label="t('subscriptions.assign.validity')" required>
        <input
          v-model.number="validityDays"
          type="number"
          min="1"
          max="3650"
          step="1"
          required
          class="input font-mono"
        />
      </FormField>

      <div v-if="group" class="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted sm:col-span-2">
        <span class="text-fg-subtle">{{ t("subscriptions.assign.limits") }}</span>
        <template v-if="caps.length">
          <span v-for="c in caps" :key="c.key" class="code-chip">
            {{ t(`subscriptions.windows.${c.key}`) }} {{ formatUsd(c.nano) }}
          </span>
        </template>
        <span v-else class="code-chip">∞ {{ t("subscriptions.table.unlimited") }}</span>
        <span class="w-full text-fg-subtle sm:w-auto">
          {{ t("subscriptions.assign.validityHint", { n: group.defaultValidityDays }) }}
        </span>
      </div>

      <div class="sm:col-span-2">
        <label class="label" for="subscription-assign-emails">
          {{ t("subscriptions.assign.users") }} <span class="text-danger">*</span>
        </label>
        <EmailChipsInput
          ref="chips"
          v-model="emails"
          input-id="subscription-assign-emails"
          :placeholder="t('subscriptions.assign.usersPlaceholder')"
        />
      </div>

      <FormField :label="t('subscriptions.assign.notes')" class="sm:col-span-2">
        <input
          v-model="notes"
          type="text"
          maxlength="200"
          :placeholder="t('subscriptions.assign.notesPlaceholder')"
          class="input"
        />
      </FormField>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="open = false">
        {{ t("common.cancel") }}
      </button>
      <button
        v-if="groups.length > 0"
        type="submit"
        form="subscription-assign"
        class="btn btn-primary"
        :disabled="!canSubmit"
      >
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ t("subscriptions.assign.submit") }}
        <span v-if="emails.length" class="rounded-full bg-white/20 px-1.5 font-mono text-2xs tabular-nums">
          {{ emails.length }}
        </span>
      </button>
    </template>
  </UiModal>
</template>
