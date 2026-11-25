<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AdminUserItem, ApiKeyItem, GroupItem, ReplaceUserGroupResponse } from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import FormField from "../../ui/FormField.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { displayName } from "./userDisplay";
import { fmtRate, useLimitText } from "./limits";
import UiSelect from "../../ui/UiSelect.vue";

/**
 * Moves a user from one group to an exclusive one (Linksyncx GroupReplaceModal): every key in
 * the old group is rebound, the new group is granted and the old grant revoked, atomically.
 * `keys` (when known) only feeds the preview counts; the server moves whatever it finds.
 */
const props = defineProps<{
  user: AdminUserItem | null;
  groups: GroupItem[];
  keys?: ApiKeyItem[] | null;
  /** Preselected source group. */
  fromGroupId?: string | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "done", res: ReplaceUserGroupResponse, fromGroupId: string, toGroupId: string): void }>();

const { t, errorOf } = useLimitText();
const toast = useToastStore();

const fromId = ref("");
const toId = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

const byId = computed(() => new Map(props.groups.map((g) => [g.id, g])));
const keyCount = (groupId: string) => (props.keys ?? []).filter((k) => k.groupId === groupId).length;

/** Sources: the user's grants plus any group their keys sit in. */
const sources = computed(() => {
  const ids = new Set<string>(props.user?.allowedGroupIds ?? []);
  for (const k of props.keys ?? []) ids.add(k.groupId);
  return [...ids]
    .map((id) => ({ id, group: byId.value.get(id) ?? null }))
    .sort((a, b) => (a.group?.sortOrder ?? 0) - (b.group?.sortOrder ?? 0) || (a.group?.name ?? a.id).localeCompare(b.group?.name ?? b.id));
});

/** Targets the server accepts: enabled, exclusive, balance-billed, not the source. */
const targets = computed(() =>
  props.groups
    .filter((g) => g.enabled && g.isExclusive && g.subscriptionType !== "subscription" && g.id !== fromId.value)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
);

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  const preset = props.fromGroupId && sources.value.some((s) => s.id === props.fromGroupId) ? props.fromGroupId : null;
  fromId.value = preset ?? sources.value[0]?.id ?? "";
  toId.value = "";
});
watch(fromId, () => {
  if (toId.value === fromId.value) toId.value = "";
});

const fromGroup = computed(() => byId.value.get(fromId.value) ?? null);
const toGroup = computed(() => byId.value.get(toId.value) ?? null);
const platformMismatch = computed(
  () =>
    fromGroup.value &&
    toGroup.value &&
    fromGroup.value.platform !== toGroup.value.platform &&
    toGroup.value.platform !== "composite",
);
const ready = computed(() => Boolean(props.user && fromId.value && toId.value && fromId.value !== toId.value) && !busy.value);

function groupLabel(g: GroupItem | null, id: string): string {
  if (!g) return t("userLimits.groups.unknown", { id });
  return `${g.name} · ${g.platform} · ×${fmtRate(g.rateMultiplier)}`;
}

async function submit() {
  const u = props.user;
  if (!u || !ready.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await apiJson<ReplaceUserGroupResponse>(`/api/v1/admin/users/${encodeURIComponent(u.id)}/replace-group`, {
      method: "POST",
      body: { fromGroupId: fromId.value, toGroupId: toId.value },
    });
    toast.success(
      t("userLimits.replace.done", {
        n: res.migratedKeys,
        from: fromGroup.value?.name ?? fromId.value,
        to: toGroup.value?.name ?? toId.value,
      }),
    );
    emit("done", res, fromId.value, toId.value);
    open.value = false;
  } catch (err) {
    error.value = errorOf(err, t("userLimits.replace.failed"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" width="md" :persistent="busy" :title="t('userLimits.replace.title')">
    <template #icon>
      <span class="icon-chip icon-chip-violet h-8 w-8"><UiIcon name="migrate" :size="15" /></span>
    </template>

    <form id="replace-group-form" class="space-y-4" @submit.prevent="submit">
      <p class="text-sm text-fg-muted">
        {{ t("userLimits.replace.intro", { name: user ? displayName(user) : "" }) }}
      </p>

      <UiAlert v-if="sources.length === 0" tone="info">{{ t("userLimits.replace.noSources") }}</UiAlert>

      <template v-else>
        <FormField :label="t('userLimits.replace.from')" required>
          <UiSelect v-model="fromId" class="select" required>
            <option v-for="s in sources" :key="s.id" :value="s.id">
              {{ groupLabel(s.group, s.id) }}{{ keys ? ` — ${t("userLimits.replace.keysIn", { n: keyCount(s.id) })}` : "" }}
            </option>
          </UiSelect>
        </FormField>

        <div class="flex justify-center text-fg-subtle" aria-hidden="true">
          <span class="icon-chip h-7 w-7 rounded-full"><UiIcon name="arrow-down" :size="14" /></span>
        </div>

        <FormField :label="t('userLimits.replace.to')" required>
          <UiSelect v-model="toId" class="select" required :disabled="targets.length === 0">
            <option value="" disabled>{{ targets.length ? t("userLimits.replace.pick") : t("userLimits.replace.noTargets") }}</option>
            <option v-for="g in targets" :key="g.id" :value="g.id">{{ groupLabel(g, g.id) }}</option>
          </UiSelect>
          <span class="hint block">{{ t("userLimits.replace.toHint") }}</span>
        </FormField>

        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0"
          leave-to-class="opacity-0"
        >
          <div v-if="toGroup" class="space-y-2">
            <UiAlert tone="info" :title="t('userLimits.replace.previewTitle')">
              <ul class="list-disc space-y-0.5 pl-4">
                <li>
                  {{
                    keys
                      ? t("userLimits.replace.previewKeys", { n: keyCount(fromId), to: toGroup.name })
                      : t("userLimits.replace.previewKeysUnknown", { to: toGroup.name })
                  }}
                </li>
                <li>{{ t("userLimits.replace.previewGrant", { to: toGroup.name }) }}</li>
                <li>{{ t("userLimits.replace.previewRevoke", { from: fromGroup?.name ?? fromId }) }}</li>
              </ul>
            </UiAlert>
            <UiAlert v-if="platformMismatch" tone="warning">
              {{ t("userLimits.replace.platformWarning", { from: fromGroup?.platform ?? "", to: toGroup.platform }) }}
            </UiAlert>
          </div>
        </Transition>
      </template>

      <UiAlert v-if="error" tone="danger" class="animate-fade-in">{{ error }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
      <button type="submit" form="replace-group-form" class="btn btn-primary" :disabled="!ready">
        <UiIcon :name="busy ? 'loader' : 'migrate'" :size="15" :spin="busy" />
        {{ busy ? t("userLimits.replace.working") : t("userLimits.replace.submit") }}
      </button>
    </template>
  </UiModal>
</template>
