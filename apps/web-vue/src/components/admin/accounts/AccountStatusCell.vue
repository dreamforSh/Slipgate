<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { TEMP_UNSCHED_REASON_PREFIX, type UpstreamAccount } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { accountStatusLabel, formatDateShort, formatDateTime, formatRelative, formatUsd } from "../../../lib/format";

/**
 * Scheduling state of one account: a switch while it is plainly on or off, otherwise the
 * runtime state (cooldown / expiry) with when it ends and how to get out of it.
 */
const props = defineProps<{
  account: UpstreamAccount;
  now: number;
  busy?: boolean;
}>();
const emit = defineEmits<{ (e: "toggle"): void; (e: "resume"): void }>();

const { t } = useI18n();

type Kind = "switch" | "cooldown" | "manual-expired" | "lapsed";

const kind = computed<Kind>(() => {
  const a = props.account;
  if (a.effectiveStatus === "cooldown") return "cooldown";
  if (a.effectiveStatus === "expired") return a.status === "expired" ? "manual-expired" : "lapsed";
  return "switch";
});

const cooldownText = computed(() =>
  props.account.cooldownUntilIso
    ? t("accounts.status.cooldownUntil", { time: formatRelative(props.account.cooldownUntilIso, props.now) })
    : t("accounts.status.cooldownManual"),
);

/** Readable cooldown cause: an admin rule, an upstream status, or the reason as typed. */
const reasonText = computed(() => {
  const reason = props.account.cooldownReason.trim();
  if (!reason) return "";
  if (reason.startsWith(TEMP_UNSCHED_REASON_PREFIX)) {
    return t("accounts.cooldownReason.rule", { label: reason.slice(TEMP_UNSCHED_REASON_PREFIX.length) });
  }
  const upstream = /^upstream_http_(\d+)$/.exec(reason);
  if (upstream) return t("accounts.cooldownReason.upstream", { status: upstream[1] });
  return reason;
});

/** Spend quota used up: the data plane stops scheduling the account until usage drops back. */
const quotaText = computed(() => {
  const q = props.account.quota;
  if (q.state === "ok") return "";
  return t(`accounts.quota.exceeded.${q.state}`);
});
const quotaTitle = computed(() => {
  const q = props.account.quota;
  const pairs: [string, string, string][] = [
    ["daily", q.dailyUsedNanoUsd, q.dailyLimitNanoUsd],
    ["weekly", q.weeklyUsedNanoUsd, q.weeklyLimitNanoUsd],
    ["total", q.totalUsedNanoUsd, q.totalLimitNanoUsd],
  ];
  return pairs
    .filter(([, , limit]) => limit !== "0")
    .map(([k, used, limit]) => `${t(`accounts.quota.${k}Limit`)} ${formatUsd(used)} / ${formatUsd(limit)}`)
    .join(" · ");
});

const cooldownTitle = computed(() =>
  [reasonText.value, props.account.cooldownUntilIso ? formatDateTime(props.account.cooldownUntilIso) : ""]
    .filter(Boolean)
    .join(" · ") || undefined,
);
</script>

<template>
  <div class="flex min-w-0 flex-col items-start gap-1">
    <UiSwitch
      v-if="kind === 'switch'"
      :model-value="account.effectiveStatus === 'active'"
      :label="accountStatusLabel(account.effectiveStatus)"
      :disabled="busy"
      @update:model-value="emit('toggle')"
    />
    <template v-else>
      <div class="flex items-center gap-1.5">
        <UiBadge :tone="kind === 'cooldown' ? 'warning' : 'danger'" dot>
          {{ accountStatusLabel(account.effectiveStatus) }}
        </UiBadge>
        <button
          v-if="kind !== 'lapsed'"
          type="button"
          class="cursor-pointer text-2xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="busy"
          @click="emit('resume')"
        >
          {{ t("accounts.status.resume") }}
        </button>
      </div>
      <template v-if="kind === 'cooldown'">
        <span class="max-w-[11rem] truncate text-2xs text-fg-subtle" :title="cooldownTitle">{{ cooldownText }}</span>
        <span v-if="reasonText" class="max-w-[11rem] truncate text-2xs text-warning" :title="cooldownTitle">{{ reasonText }}</span>
      </template>
      <span
        v-else-if="kind === 'lapsed' && account.expiresAtIso"
        class="max-w-[11rem] truncate text-2xs text-fg-subtle"
        :title="t('accounts.status.renewHint')"
      >
        {{ t("accounts.status.expiredOn", { date: formatDateShort(account.expiresAtIso) }) }}
      </span>
    </template>
    <span v-if="quotaText" class="max-w-[11rem] truncate text-2xs font-medium text-danger" :title="quotaTitle">
      {{ quotaText }}
    </span>
  </div>
</template>
