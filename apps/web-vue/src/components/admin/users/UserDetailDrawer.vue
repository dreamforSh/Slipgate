<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AdminUserItem, ApiKeyItem, GroupItem, ReplaceUserGroupResponse } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiTabs from "../../ui/UiTabs.vue";
import ReplaceGroupModal from "./ReplaceGroupModal.vue";
import UserApiKeysPanel from "./UserApiKeysPanel.vue";
import UserAttributesPanel from "./UserAttributesPanel.vue";
import UserGroupRatesPanel from "./UserGroupRatesPanel.vue";
import UserLimitsPanel from "./UserLimitsPanel.vue";
import UserPlatformQuotasPanel from "./UserPlatformQuotasPanel.vue";
import { STATUS_TONE, avatarTone, displayName, initial } from "./userDisplay";
import { useLimitText } from "./limits";

export type UserDetailTab = "limits" | "rates" | "quotas" | "keys" | "attributes";

/** One user's caps and live status, per-group rates / RPM overrides and API keys. */
const props = defineProps<{ user: AdminUserItem | null; groups: GroupItem[] }>();
const open = defineModel<boolean>("open", { required: true });
const tab = defineModel<UserDetailTab>("tab", { default: "limits" });
const emit = defineEmits<{ (e: "changed"): void }>();

const { t, capText } = useLimitText();

/** Local copy so saved caps and grants show at once (the list reloads in the background). */
const current = ref<AdminUserItem | null>(null);
watch(
  () => [open.value, props.user] as const,
  ([isOpen, u]) => {
    if (isOpen && u) current.value = { ...u };
  },
  { immediate: true },
);

const tabs = computed(() => [
  { key: "limits" as const, label: t("userLimits.drawer.tabs.limits"), icon: "gauge" as const },
  { key: "rates" as const, label: t("userLimits.drawer.tabs.rates"), icon: "percent" as const },
  { key: "quotas" as const, label: t("userLimits.drawer.tabs.quotas"), icon: "sliders" as const },
  { key: "attributes" as const, label: t("userLimits.drawer.tabs.attributes"), icon: "user" as const },
  { key: "keys" as const, label: t("userLimits.drawer.tabs.keys"), icon: "key" as const, count: current.value?.apiKeyCount },
]);

const groupNames = computed(() => new Map(props.groups.map((g) => [g.id, g.name])));

function onSaved(u: AdminUserItem) {
  current.value = { ...u };
  emit("changed");
}

function onGranted(groupId: string) {
  const u = current.value;
  if (u && !u.allowedGroupIds.includes(groupId)) current.value = { ...u, allowedGroupIds: [...u.allowedGroupIds, groupId] };
  emit("changed");
}

/* ---------------- Replace exclusive group ---------------- */

const keysPanel = ref<InstanceType<typeof UserApiKeysPanel> | null>(null);
const replaceOpen = ref(false);
const replaceKeys = ref<ApiKeyItem[] | null>(null);

function openReplace(keys: ApiKeyItem[]) {
  replaceKeys.value = keys;
  replaceOpen.value = true;
}

function onReplaced(res: ReplaceUserGroupResponse) {
  const u = current.value;
  if (u) current.value = { ...u, allowedGroupIds: res.allowedGroupIds };
  void keysPanel.value?.reload();
  emit("changed");
}
</script>

<template>
  <UiDrawer v-model:open="open" width="xl" :title="current ? t('userLimits.drawer.title', { name: displayName(current) }) : ''">
    <template v-if="current">
      <!-- Identity -->
      <div class="flex items-start gap-3">
        <span
          class="icon-chip h-11 w-11 rounded-full text-base font-semibold"
          :class="current.status === 'suspended' ? '' : avatarTone(current.id)"
          aria-hidden="true"
        >
          {{ initial(current) }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-fg">{{ displayName(current) }}</p>
          <p class="truncate text-xs text-fg-subtle">{{ current.email }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <UiBadge :tone="current.role === 'admin' ? 'violet' : current.role === 'group_manager' ? 'info' : 'neutral'">{{ t(`adminUsers.roles.${current.role}`) }}</UiBadge>
            <UiBadge :tone="STATUS_TONE[current.status]" dot>{{ t(`adminUsers.statuses.${current.status}`) }}</UiBadge>
            <UiBadge tone="accent" mono :title="t('userLimits.fields.rpm')">
              <UiIcon name="gauge" :size="10" class="-ml-0.5 mr-0.5 inline" />{{ capText(current.effectiveRpmLimit ?? 0, "rpm") }}
            </UiBadge>
            <UiBadge tone="info" mono :title="t('userLimits.fields.concurrency')">
              <UiIcon name="activity" :size="10" class="-ml-0.5 mr-0.5 inline" />{{ capText(current.effectiveConcurrencyLimit ?? 0, "concurrency") }}
            </UiBadge>
          </div>
        </div>
      </div>

      <div v-if="current.allowedGroupIds.length" class="mt-3 flex flex-wrap items-center gap-1.5 text-2xs">
        <span class="text-fg-subtle">{{ t("userLimits.drawer.granted") }}</span>
        <TransitionGroup
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="scale-95 opacity-0"
          leave-to-class="scale-95 opacity-0"
        >
          <span
            v-for="gid in current.allowedGroupIds"
            :key="gid"
            class="inline-flex items-center gap-1 rounded-full bg-violet/10 px-2 py-0.5 font-medium text-violet ring-1 ring-inset ring-violet/20"
          >
            <UiIcon name="lock" :size="9" />{{ groupNames.get(gid) ?? gid }}
          </span>
        </TransitionGroup>
      </div>

      <div v-if="current.role === 'group_manager' && current.managedGroupIds?.length" class="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
        <span class="text-fg-subtle">{{ t("adminUsers.form.managedGroups") }}:</span>
        <span
          v-for="gid in current.managedGroupIds"
          :key="`mg-${gid}`"
          class="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 font-medium text-info ring-1 ring-inset ring-info/20"
        >
          <UiIcon name="layers" :size="9" />{{ groupNames.get(gid) ?? gid }}
        </span>
      </div>

      <UiTabs v-model="tab" :tabs="tabs" class="mt-5" />

      <div class="pt-5">
        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0"
          leave-to-class="opacity-0"
        >
          <KeepAlive :max="4">
            <UserLimitsPanel v-if="tab === 'limits'" :key="`l-${current.id}`" :user="current" :active="open && tab === 'limits'" @saved="onSaved" />
            <UserGroupRatesPanel v-else-if="tab === 'rates'" :key="`r-${current.id}`" :user="current" :active="open && tab === 'rates'" @saved="emit('changed')" />
            <UserPlatformQuotasPanel v-else-if="tab === 'quotas'" :key="`q-${current.id}`" :user="current" :active="open && tab === 'quotas'" @saved="emit('changed')" />
            <UserAttributesPanel v-else-if="tab === 'attributes'" :key="`a-${current.id}`" :user-id="current.id" :active="open && tab === 'attributes'" />
            <UserApiKeysPanel
              v-else
              ref="keysPanel"
              :key="`k-${current.id}`"
              :user="current"
              :groups="groups"
              :active="open && tab === 'keys'"
              @changed="emit('changed')"
              @granted="onGranted"
              @replace="openReplace"
              @navigate="open = false"
            />
          </KeepAlive>
        </Transition>
      </div>
    </template>
  </UiDrawer>

  <ReplaceGroupModal v-model:open="replaceOpen" :user="current" :groups="groups" :keys="replaceKeys" @done="onReplaced" />
</template>
