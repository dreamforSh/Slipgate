<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem } from "@slipgate/contracts";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";
import { hasIpRules, isExpired } from "./keyLimits";

/** Compact state chips for a key: spend-limit state, expiry and IP restrictions. */
const props = defineProps<{ item: ApiKeyItem; now: number }>();

const { t } = useI18n();

const expired = computed(() => isExpired(props.item, props.now));
const ipTitle = computed(() =>
  t("user.keys.ipRestricted", { allow: props.item.ipAllowlist.length, deny: props.item.ipDenylist?.length ?? 0 }),
);
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1">
    <UiBadge v-if="item.limitState === 'quota_exhausted'" tone="danger" dot>{{ t("user.keys.limitState.quota_exhausted") }}</UiBadge>
    <UiBadge v-else-if="item.limitState === 'window_exhausted'" tone="warning" dot>
      {{ t("user.keys.limitState.window_exhausted") }}
    </UiBadge>
    <UiBadge v-if="expired" tone="danger">{{ t("user.keys.expired") }}</UiBadge>
    <span
      v-if="hasIpRules(item)"
      class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-info/10 text-info ring-1 ring-inset ring-info/20"
      :title="ipTitle"
    >
      <UiIcon name="shield" :size="11" />
      <span class="sr-only">{{ ipTitle }}</span>
    </span>
  </span>
</template>
