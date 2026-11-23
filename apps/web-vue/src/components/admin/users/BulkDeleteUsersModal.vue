<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { USER_BATCH_MAX, type AdminBatchDeleteUsersResponse, type AdminUserItem } from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { displayName } from "./userDisplay";
import { useLimitText } from "./limits";

/**
 * Deletes the selected users in one call (POST /admin/users/batch-delete). The signed-in admin
 * is never sent; the server reports each refusal (orders, rebates, last admin…), shown afterwards.
 */
const props = defineProps<{ users: AdminUserItem[]; selfId: string | null }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "done", deleted: string[]): void }>();

const { t, errorOf } = useLimitText();
const toast = useToastStore();

const acknowledged = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const result = ref<AdminBatchDeleteUsersResponse | null>(null);

const targets = computed(() => props.users.filter((u) => u.id !== props.selfId));
const preview = computed(() => targets.value.slice(0, 6));
const byId = computed(() => new Map(props.users.map((u) => [u.id, u])));
const withKeys = computed(() => targets.value.filter((u) => u.apiKeyCount > 0).length);
const withBalance = computed(() => targets.value.filter((u) => /^[1-9]/.test(u.balanceNanoUsd)).length);
const tooMany = computed(() => targets.value.length > USER_BATCH_MAX);

watch(open, (isOpen) => {
  if (!isOpen) return;
  acknowledged.value = false;
  error.value = null;
  result.value = null;
});

function reason(code: string): string {
  const known = ["self", "not_found", "conflict", "internal_error"];
  return t(`userLimits.bulkDelete.reasons.${known.includes(code) ? code : "internal_error"}`);
}

async function submit() {
  if (busy.value || !acknowledged.value || targets.value.length === 0 || tooMany.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await apiJson<AdminBatchDeleteUsersResponse>("/api/v1/admin/users/batch-delete", {
      method: "POST",
      body: { userIds: targets.value.map((u) => u.id) },
    });
    result.value = res;
    if (res.deleted.length) emit("done", res.deleted);
    if (res.failed.length === 0) {
      toast.success(t("userLimits.bulkDelete.done", { n: res.deleted.length }));
      open.value = false;
    } else if (res.deleted.length) {
      toast.warning(t("userLimits.bulkDelete.partial", { ok: res.deleted.length, failed: res.failed.length }));
    }
  } catch (err) {
    error.value = errorOf(err, t("userLimits.bulkDelete.failed"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" width="md" :persistent="busy" :title="t('userLimits.bulkDelete.title')">
    <template #icon>
      <span class="icon-chip icon-chip-danger h-8 w-8"><UiIcon name="trash" :size="15" /></span>
    </template>

    <!-- Result -->
    <div v-if="result" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-3">
          <p class="text-2xs text-fg-subtle">{{ t("userLimits.bulkDelete.deleted") }}</p>
          <p class="mt-0.5 font-mono text-xl font-semibold tabular-nums text-success">{{ result.deleted.length }}</p>
        </div>
        <div class="rounded-lg border border-danger/25 bg-danger/[0.06] px-3.5 py-3">
          <p class="text-2xs text-fg-subtle">{{ t("userLimits.bulkDelete.failedCount") }}</p>
          <p class="mt-0.5 font-mono text-xl font-semibold tabular-nums text-danger">{{ result.failed.length }}</p>
        </div>
      </div>
      <ul class="max-h-64 divide-y divide-line/60 overflow-y-auto rounded-lg border border-line/70">
        <li v-for="f in result.failed" :key="f.userId" class="animate-fade-in px-3.5 py-2.5">
          <p class="flex items-center justify-between gap-2">
            <span class="truncate text-sm font-medium text-fg">{{ byId.get(f.userId)?.email ?? f.userId }}</span>
            <span class="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-2xs font-medium text-danger">{{ reason(f.error) }}</span>
          </p>
          <p v-if="f.message" class="mt-0.5 truncate text-2xs text-fg-subtle" :title="f.message">{{ f.message }}</p>
        </li>
      </ul>
    </div>

    <!-- Confirm -->
    <div v-else class="space-y-4">
      <UiAlert tone="danger" :title="t('userLimits.bulkDelete.warnTitle', { n: targets.length })">
        {{ t("userLimits.bulkDelete.warn") }}
      </UiAlert>

      <div class="flex flex-wrap gap-2 text-xs">
        <span v-if="withKeys" class="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-warning">
          <UiIcon name="key" :size="11" />{{ t("userLimits.bulkDelete.withKeys", { n: withKeys }) }}
        </span>
        <span v-if="withBalance" class="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-warning">
          <UiIcon name="wallet" :size="11" />{{ t("userLimits.bulkDelete.withBalance", { n: withBalance }) }}
        </span>
        <span v-if="users.length !== targets.length" class="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-fg-muted">
          <UiIcon name="lock" :size="11" />{{ t("userLimits.bulkDelete.selfSkipped") }}
        </span>
      </div>

      <ul class="divide-y divide-line/60 rounded-lg border border-line/70">
        <li v-for="u in preview" :key="u.id" class="flex items-center justify-between gap-3 px-3.5 py-2">
          <span class="min-w-0">
            <span class="block truncate text-sm text-fg">{{ displayName(u) }}</span>
            <span class="block truncate text-2xs text-fg-subtle">{{ u.email }}</span>
          </span>
          <span v-if="u.role === 'admin'" class="shrink-0 rounded-full bg-violet/10 px-2 py-0.5 text-2xs font-medium text-violet">
            {{ t("adminUsers.roles.admin") }}
          </span>
        </li>
        <li v-if="targets.length > preview.length" class="px-3.5 py-2 text-xs text-fg-subtle">
          {{ t("userLimits.bulkDelete.more", { n: targets.length - preview.length }) }}
        </li>
      </ul>

      <p v-if="tooMany" class="text-xs text-danger">{{ t("userLimits.bulk.tooMany", { max: USER_BATCH_MAX }) }}</p>

      <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line/80 bg-surface-2/40 px-3.5 py-3 text-sm">
        <input v-model="acknowledged" type="checkbox" class="checkbox mt-0.5" />
        <span class="text-fg">{{ t("userLimits.bulkDelete.ack", { n: targets.length }) }}</span>
      </label>
      <UiAlert v-if="error" tone="danger" class="animate-fade-in">{{ error }}</UiAlert>
    </div>

    <template #footer>
      <template v-if="result">
        <button type="button" class="btn btn-primary" @click="open = false">{{ t("common.close") }}</button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
        <button
          type="button"
          class="btn btn-danger-solid"
          :disabled="busy || !acknowledged || targets.length === 0 || tooMany"
          @click="submit"
        >
          <UiIcon :name="busy ? 'loader' : 'trash'" :size="15" :spin="busy" />
          {{ busy ? t("userLimits.bulkDelete.deleting") : t("userLimits.bulkDelete.submit", { n: targets.length }) }}
        </button>
      </template>
    </template>
  </UiModal>
</template>
