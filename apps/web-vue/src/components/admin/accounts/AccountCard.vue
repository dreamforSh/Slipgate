<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountExitBinding, AccountUsageSummaryItem, ClashExitNode, UpstreamAccount } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UsageMeter from "../../ui/UsageMeter.vue";
import AccountExitCell from "./AccountExitCell.vue";
import AccountStatusCell from "./AccountStatusCell.vue";
import PlatformTypeBadge from "./PlatformTypeBadge.vue";
import AccountPrivacyBadge from "./AccountPrivacyBadge.vue";
import AccountQuotaMeter from "./AccountQuotaMeter.vue";
import PriorityStepper from "./PriorityStepper.vue";
import { EXPIRY_TONE, MODE_ICON, expiryState } from "./accountDisplay";
import { modeUsesExit } from "./exitPool";
import { platformStyle } from "../../../lib/platformStyle";
import {
  executionModeLabel,
  formatCompact,
  formatDateShort,
  formatDurationMs,
  formatRelative,
  formatUsd,
} from "../../../lib/format";

const props = defineProps<{
  account: UpstreamAccount;
  selected: boolean;
  today: AccountUsageSummaryItem | null;
  now: number;
  busy: boolean;
  exitBinding: AccountExitBinding | null;
  exitNode: ClashExitNode | null;
  /** The exit pool reflects slipgate-net (not standalone samples, not a failed load). */
  exitReady: boolean;
  /** Interval of the account's enabled scheduled test, minutes. */
  scheduledMinutes?: number | null;
}>();

const emit = defineEmits<{
  (e: "toggle-select"): void;
  (e: "filter-group", groupId: string): void;
  (e: "toggle-status" | "resume" | "test" | "edit" | "stats"): void;
  (e: "menu", anchor: HTMLElement): void;
  (e: "priority", value: number): void;
  (e: "exit"): void;
}>();

const { t, te } = useI18n();

const acc = computed(() => props.account);
const platform = computed(() => platformStyle(acc.value.platform));
const authLabel = computed(() => {
  const key = `accounts.authKinds.${acc.value.authKind}`;
  return te(key) ? t(key) : acc.value.authKind;
});

/** Dot color of the access-mode line under the platform badge. */
const MODE_DOT: Record<string, string> = {
  stealth_http: "bg-info",
  direct_api: "bg-success",
  vm_slot: "bg-violet",
};
const expiry = computed(() => expiryState(acc.value, props.now));
/** Exit-routed account with no exit: slipgate-net refuses its traffic until one is bound. */
const exitMissing = computed(() => props.exitReady && !props.exitBinding && modeUsesExit(acc.value.executionMode));

const todayTitle = computed(() => {
  const d = props.today;
  if (!d) return t("accounts.today.none");
  return [
    t("accounts.today.requests", { n: formatCompact(d.requests) }),
    d.errors ? t("accounts.today.errors", { n: d.errors }) : "",
    `${formatCompact(d.inputTokens + d.outputTokens)} tok`,
    formatUsd(d.costNanoUsd),
  ]
    .filter(Boolean)
    .join(" · ");
});

const lastTestClass = computed(() => {
  if (!acc.value.lastTest) return "bg-surface-2/60 text-fg-subtle";
  if (acc.value.lastTest.ok) return "bg-success/[0.07] text-fg-muted";
  return "bg-danger/[0.07] text-danger ring-1 ring-inset ring-danger/15";
});
</script>

<template>
  <article
    class="card card-hover relative flex min-w-0 flex-col p-4 pt-5"
    :class="[
      selected ? '!border-accent/50 ring-2 ring-accent/30' : platform.border,
      acc.effectiveStatus === 'active' ? '' : 'opacity-80',
    ]"
  >
    <!-- Platform accent bar (inset by the border, so it follows the rounded corners) -->
    <div class="pointer-events-none absolute inset-x-0 top-0 h-1 rounded-t-[11px]" :class="platform.bar" aria-hidden="true" />

    <!-- Header: select, name + group, scheduling -->
    <div class="flex items-start gap-3">
      <input
        type="checkbox"
        class="checkbox mt-1"
        :checked="selected"
        :aria-label="t('accounts.card.select', { name: acc.name })"
        @change="emit('toggle-select')"
      />
      <div class="min-w-0 flex-1">
        <button
          type="button"
          class="block max-w-full cursor-pointer truncate text-left text-sm font-semibold text-fg transition-colors hover:text-accent"
          :title="t('accounts.card.openStats')"
              :aria-label="t('accounts.row.labelFor', { action: t('accounts.card.openStats'), name: acc.name })"
          @click="emit('stats')"
        >
          {{ acc.name }}
        </button>
        <button
          type="button"
          class="mt-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 text-xs text-fg-muted transition-colors hover:text-accent"
          :title="t('accounts.card.filterGroup')"
          @click="emit('filter-group', acc.groupId)"
        >
          <UiIcon name="layers" :size="12" />
          <span class="truncate" :class="{ italic: !acc.groupId }">{{ acc.groupName || t("accounts.ungrouped") }}</span>
        </button>
      </div>
      <div class="shrink-0">
        <AccountStatusCell :account="acc" :now="now" :busy="busy" @toggle="emit('toggle-status')" @resume="emit('resume')" />
      </div>
    </div>

    <!-- Platform + auth type, plan, access mode -->
    <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <PlatformTypeBadge
        inline
        :platform="acc.platform"
        :auth-kind="acc.authKind"
        :subscription-tier="acc.subscriptionTier"
        :tier-multiplier="acc.tierMultiplier"
      />
      <span
        class="inline-flex items-center gap-1.5 text-2xs font-medium text-fg-muted"
        :title="`${executionModeLabel(acc.executionMode)} · ${authLabel}`"
      >
        <span class="h-1.5 w-1.5 rounded-full" :class="MODE_DOT[acc.executionMode]" />
        <UiIcon :name="MODE_ICON[acc.executionMode]" :size="11" />
        {{ executionModeLabel(acc.executionMode) }}
      </span>
      <AccountPrivacyBadge :account="acc" />
    </div>

    <!-- Exit proxy -->
    <div
      class="mt-2.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5"
      :class="exitMissing ? 'bg-warning/[0.07] ring-1 ring-inset ring-warning/20' : 'bg-surface-2/60'"
    >
      <UiIcon name="network" :size="12" class="shrink-0 text-fg-subtle" />
      <AccountExitCell
        inline
        class="flex-1"
        :mode="acc.executionMode"
        :binding="exitBinding"
        :node="exitNode"
        :ready="exitReady"
        :editable="exitReady && acc.executionMode !== 'vm_slot'"
        @change="emit('exit')"
      />
    </div>

    <!-- Notes + credential -->
    <p v-if="acc.notes" class="mt-2.5 truncate text-xs text-fg-muted" :title="acc.notes">{{ acc.notes }}</p>
    <p class="truncate font-mono text-2xs text-fg-subtle" :class="acc.notes ? 'mt-1' : 'mt-2.5'" :title="acc.id">
      {{ acc.credentialPreview }}
    </p>

    <!-- Usage windows -->
    <div class="mt-3 grid grid-cols-2 gap-3">
      <UsageMeter label="5h" :bps="acc.window5hUsedBps" />
      <UsageMeter label="7d" :bps="acc.window7dUsedBps" />
    </div>
    <!-- Spend quota (only when a limit is set) -->
    <AccountQuotaMeter :quota="acc.quota" class="mt-2.5" />

    <!-- Limits + today -->
    <!-- The middle cell sizes to the priority stepper; the other two share the rest -->
    <dl class="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2">
      <div class="rounded-lg bg-surface-2/60 px-2.5 py-1.5">
        <dt class="text-2xs text-fg-subtle">{{ t("accounts.card.concurrency") }}</dt>
        <dd class="font-mono text-sm font-medium tabular-nums text-fg">{{ acc.maxConcurrency }}</dd>
      </div>
      <div class="rounded-lg bg-surface-2/60 px-2.5 py-1.5">
        <dt class="text-2xs text-fg-subtle">{{ t("accounts.card.priority") }}</dt>
        <dd class="mt-0.5">
          <PriorityStepper :value="acc.priority" :name="acc.name" :disabled="busy" @commit="emit('priority', $event)" />
        </dd>
      </div>
      <div class="rounded-lg bg-surface-2/60 px-2.5 py-1.5" :title="todayTitle">
        <dt class="text-2xs text-fg-subtle">{{ t("accounts.card.today") }}</dt>
        <dd class="font-mono text-sm font-medium tabular-nums" :class="today?.errors ? 'text-warning' : 'text-fg'">
          {{ today ? formatCompact(today.requests) : "—" }}
        </dd>
      </div>
    </dl>

    <!-- Expiry + last used -->
    <div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
      <span class="inline-flex items-center gap-1">
        <UiIcon name="calendar" :size="12" />
        <template v-if="acc.expiresAtIso">
          <UiBadge v-if="expiry !== 'ok'" :tone="EXPIRY_TONE[expiry]">
            {{ expiry === "expired" ? t("accounts.expiry.expired") : t("accounts.status.expiresIn", { time: formatRelative(acc.expiresAtIso, now) }) }}
          </UiBadge>
          <span v-else class="font-mono">{{ formatDateShort(acc.expiresAtIso) }}</span>
        </template>
        <span v-else>{{ t("accounts.expiry.none") }}</span>
      </span>
      <span class="inline-flex items-center gap-1">
        <UiIcon name="activity" :size="12" />
        {{ acc.lastUsedAtIso ? formatRelative(acc.lastUsedAtIso, now) : t("accounts.lastUsed.never") }}
      </span>
    </div>

    <div class="flex-1" />

    <!-- Last test -->
    <div
      class="mt-3 flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs"
      :class="lastTestClass"
      :title="acc.lastTest ? acc.lastTest.message || acc.lastTest.model : undefined"
    >
      <span class="inline-flex min-w-0 items-center gap-1.5">
        <UiIcon
          :name="!acc.lastTest ? 'clock' : acc.lastTest.ok ? 'check-circle' : 'x-circle'"
          :size="13"
          :class="acc.lastTest?.ok ? 'text-success' : ''"
        />
        <span class="truncate font-medium">
          {{ !acc.lastTest ? t("accounts.lastTest.never") : acc.lastTest.ok ? t("accounts.lastTest.ok") : t("accounts.lastTest.failed") }}
        </span>
      </span>
      <span v-if="scheduledMinutes" class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-accent" :title="t('accounts.schedule.badge', { n: scheduledMinutes })">
        <UiIcon name="clock" :size="10" />{{ scheduledMinutes }}m
      </span>
      <span v-if="acc.lastTest" class="shrink-0 font-mono text-2xs opacity-80">
        {{ formatRelative(acc.lastTest.atIso, now) }} · {{ formatDurationMs(acc.lastTest.durationMs) }}
      </span>
    </div>

    <!-- Actions -->
    <div class="mt-3 flex items-center gap-1 border-t border-line/70 pt-3">
      <button
        type="button"
        class="btn btn-ghost btn-sm text-accent hover:!bg-accent/10 hover:!text-accent"
        :disabled="acc.executionMode === 'vm_slot'"
        :title="acc.executionMode === 'vm_slot' ? t('accounts.row.vmTestDisabled') : undefined"
        @click="emit('test')"
      >
        <UiIcon name="play" :size="13" />
        {{ t("accounts.row.test") }}
      </button>
      <div class="ml-auto flex items-center gap-1">
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          :title="t('accounts.row.stats')"
          :aria-label="t('accounts.row.labelFor', { action: t('accounts.row.stats'), name: acc.name })"
          @click="emit('stats')"
        >
          <UiIcon name="chart" :size="14" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          :title="t('accounts.row.edit')"
          :aria-label="t('accounts.row.labelFor', { action: t('accounts.row.edit'), name: acc.name })"
          @click="emit('edit')"
        >
          <UiIcon name="pencil" :size="14" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          aria-haspopup="menu"
          :title="t('accounts.row.more')"
          :aria-label="t('accounts.row.labelFor', { action: t('accounts.row.more'), name: acc.name })"
          @click="emit('menu', $event.currentTarget as HTMLElement)"
        >
          <UiIcon name="more" :size="16" />
        </button>
      </div>
    </div>
  </article>
</template>
