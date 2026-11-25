<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountUsageSummaryItem, UpstreamAccount } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UsageMeter from "../../ui/UsageMeter.vue";
import AccountExitCell from "./AccountExitCell.vue";
import AccountStatusCell from "./AccountStatusCell.vue";
import PlatformTypeBadge from "./PlatformTypeBadge.vue";
import AccountPrivacyBadge from "./AccountPrivacyBadge.vue";
import PriorityStepper from "./PriorityStepper.vue";
import type { ExitPool } from "./exitPool";
import {
  COLUMN_SORT,
  EXPIRY_TONE,
  MODE_ICON,
  expiryState,
  type ColumnKey,
  type SortKey,
  type SortState,
} from "./accountDisplay";
import {
  executionModeLabel,
  formatCompact,
  formatDateShort,
  formatDurationMs,
  formatRelative,
  formatTokens,
  formatUsd,
} from "../../../lib/format";

const props = defineProps<{
  accounts: UpstreamAccount[];
  columns: ColumnKey[];
  sort: SortState;
  selected: ReadonlySet<string>;
  today: ReadonlyMap<string, AccountUsageSummaryItem>;
  now: number;
  busy: ReadonlySet<string>;
  exitPool: ExitPool;
  /** The exit pool reflects slipgate-net (not standalone samples, not a failed load). */
  exitReady: boolean;
  /** Accounts with an enabled scheduled test → interval in minutes. */
  scheduled?: ReadonlyMap<string, number>;
}>();

const emit = defineEmits<{
  (e: "toggle-select", id: string): void;
  (e: "toggle-page"): void;
  (e: "sort", key: SortKey): void;
  (e: "filter-group", groupId: string): void;
  (e: "toggle-status" | "resume" | "test" | "edit" | "stats", account: UpstreamAccount): void;
  (e: "menu", account: UpstreamAccount, anchor: HTMLElement): void;
  (e: "priority", account: UpstreamAccount, value: number): void;
  (e: "exit", account: UpstreamAccount): void;
}>();

const { t, te } = useI18n();

const visible = computed(() => new Set(props.columns));
const allSelected = computed(() => props.accounts.length > 0 && props.accounts.every((a) => props.selected.has(a.id)));
const someSelected = computed(() => !allSelected.value && props.accounts.some((a) => props.selected.has(a.id)));

function authKindLabel(kind: string): string {
  const key = `accounts.authKinds.${kind}`;
  return te(key) ? t(key) : kind;
}

function sortIcon(key: SortKey | undefined) {
  if (!key || props.sort.key !== key) return null;
  return props.sort.dir === "asc" ? "arrow-up" : "arrow-down";
}

function ariaSort(key: SortKey | undefined): "ascending" | "descending" | undefined {
  if (!key || props.sort.key !== key) return undefined;
  return props.sort.dir === "asc" ? "ascending" : "descending";
}

const HEADER_KEYS: ColumnKey[] = ["group", "platform", "exit", "status", "usage", "today", "limits", "lastTest", "lastUsed", "expires", "created"];

function exitBinding(acc: UpstreamAccount) {
  return props.exitPool.bindingByAccount.get(acc.id) ?? null;
}
function exitNode(acc: UpstreamAccount) {
  const b = exitBinding(acc);
  return b ? props.exitPool.nodeById.get(b.nodeId) ?? null : null;
}
const headers = computed(() => HEADER_KEYS.filter((k) => visible.value.has(k)));

function openMenu(acc: UpstreamAccount, ev: MouseEvent) {
  emit("menu", acc, ev.currentTarget as HTMLElement);
}
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th class="w-10">
            <input
              type="checkbox"
              class="checkbox"
              :checked="allSelected"
              :indeterminate="someSelected"
              :aria-label="t('accounts.card.selectPage')"
              @change="emit('toggle-page')"
            />
          </th>
          <th :aria-sort="ariaSort('name')">
            <button type="button" class="inline-flex cursor-pointer items-center gap-1 hover:text-fg" @click="emit('sort', 'name')">
              {{ t("accounts.columns.name") }}
              <UiIcon v-if="sortIcon('name')" :name="sortIcon('name')!" :size="12" class="text-accent" />
            </button>
          </th>
          <th v-for="key in headers" :key="key" :aria-sort="ariaSort(COLUMN_SORT[key])">
            <button
              v-if="COLUMN_SORT[key]"
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 hover:text-fg"
              @click="emit('sort', COLUMN_SORT[key]!)"
            >
              {{ t(`accounts.columns.${key}`) }}
              <UiIcon v-if="sortIcon(COLUMN_SORT[key])" :name="sortIcon(COLUMN_SORT[key])!" :size="12" class="text-accent" />
            </button>
            <span v-else>{{ t(`accounts.columns.${key}`) }}</span>
          </th>
          <th class="sticky-end text-right">{{ t("accounts.columns.actions") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="acc in accounts"
          :key="acc.id"
          :class="[
            selected.has(acc.id) ? 'is-selected !bg-accent/[0.06]' : '',
            acc.effectiveStatus === 'active' ? '' : 'text-fg-muted',
          ]"
        >
          <td>
            <input
              type="checkbox"
              class="checkbox"
              :checked="selected.has(acc.id)"
              :aria-label="t('accounts.card.select', { name: acc.name })"
              @change="emit('toggle-select', acc.id)"
            />
          </td>

          <!-- Name, id, credential, notes -->
          <td class="min-w-[12rem] max-w-[18rem]">
            <button
              type="button"
              class="block max-w-full cursor-pointer truncate text-left font-medium text-fg transition-colors hover:text-accent"
              :title="t('accounts.card.openStats')"
              :aria-label="t('accounts.row.labelFor', { action: t('accounts.card.openStats'), name: acc.name })"
              @click="emit('stats', acc)"
            >
              {{ acc.name }}
            </button>
            <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle" :title="`${acc.id} · ${acc.credentialPreview}`">
              {{ acc.credentialPreview }}
            </p>
            <p v-if="acc.notes" class="mt-0.5 truncate text-2xs text-fg-muted" :title="acc.notes">{{ acc.notes }}</p>
          </td>

          <td v-if="visible.has('group')">
            <button
              type="button"
              class="inline-flex max-w-[10rem] cursor-pointer items-center gap-1 text-xs text-fg-muted transition-colors hover:text-accent"
              :title="t('accounts.card.filterGroup')"
              @click="emit('filter-group', acc.groupId)"
            >
              <UiIcon name="layers" :size="12" />
              <span class="truncate" :class="{ italic: !acc.groupId }">{{ acc.groupName || t("accounts.ungrouped") }}</span>
            </button>
          </td>

          <td v-if="visible.has('platform')" class="min-w-[13rem]">
            <PlatformTypeBadge
              inline
              :platform="acc.platform"
              :auth-kind="acc.authKind"
              :subscription-tier="acc.subscriptionTier"
              :tier-multiplier="acc.tierMultiplier"
            />
            <div class="mt-1 flex items-center gap-1.5 text-2xs text-fg-subtle" :title="authKindLabel(acc.authKind)">
              <UiIcon :name="MODE_ICON[acc.executionMode]" :size="11" />
              <span>{{ executionModeLabel(acc.executionMode) }}</span>
              <AccountPrivacyBadge :account="acc" />
            </div>
          </td>

          <td v-if="visible.has('exit')" class="min-w-[9rem] max-w-[13rem]">
            <AccountExitCell
              :mode="acc.executionMode"
              :binding="exitBinding(acc)"
              :node="exitNode(acc)"
              :ready="exitReady"
              :editable="exitReady && acc.executionMode !== 'vm_slot'"
              @change="emit('exit', acc)"
            />
          </td>

          <td v-if="visible.has('status')">
            <AccountStatusCell
              :account="acc"
              :now="now"
              :busy="busy.has(acc.id)"
              @toggle="emit('toggle-status', acc)"
              @resume="emit('resume', acc)"
            />
          </td>

          <td v-if="visible.has('usage')" class="w-32">
            <div class="space-y-1.5">
              <UsageMeter label="5h" :bps="acc.window5hUsedBps" />
              <UsageMeter label="7d" :bps="acc.window7dUsedBps" />
            </div>
          </td>

          <td v-if="visible.has('today')" class="whitespace-nowrap">
            <template v-if="today.get(acc.id)">
              <p class="font-mono text-xs tabular-nums text-fg">
                {{ t("accounts.today.requests", { n: formatCompact(today.get(acc.id)!.requests) }) }}
                <span v-if="today.get(acc.id)!.errors" class="text-warning">
                  · {{ t("accounts.today.errors", { n: today.get(acc.id)!.errors }) }}
                </span>
              </p>
              <p class="mt-0.5 font-mono text-2xs tabular-nums text-fg-subtle">
                {{ formatTokens(today.get(acc.id)!.inputTokens + today.get(acc.id)!.outputTokens) }} tok ·
                {{ formatUsd(today.get(acc.id)!.costNanoUsd) }}
              </p>
            </template>
            <span v-else class="text-xs text-fg-subtle">—</span>
          </td>

          <td v-if="visible.has('limits')" class="whitespace-nowrap">
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs tabular-nums text-fg" :title="t('accounts.card.concurrency')">{{ acc.maxConcurrency }}</span>
              <PriorityStepper
                :value="acc.priority"
                :name="acc.name"
                :disabled="busy.has(acc.id)"
                @commit="emit('priority', acc, $event)"
              />
            </div>
          </td>

          <td v-if="visible.has('lastTest')" class="whitespace-nowrap">
            <span
              class="inline-flex items-center gap-1.5 text-xs"
              :class="!acc.lastTest ? 'text-fg-subtle' : acc.lastTest.ok ? 'text-fg-muted' : 'text-danger'"
              :title="acc.lastTest ? acc.lastTest.message || acc.lastTest.model : undefined"
            >
              <UiIcon
                :name="!acc.lastTest ? 'clock' : acc.lastTest.ok ? 'check-circle' : 'x-circle'"
                :size="13"
                :class="acc.lastTest?.ok ? 'text-success' : ''"
              />
              {{ !acc.lastTest ? t("accounts.lastTest.never") : acc.lastTest.ok ? t("accounts.lastTest.ok") : t("accounts.lastTest.failed") }}
            </span>
            <p v-if="acc.lastTest" class="mt-0.5 font-mono text-2xs text-fg-subtle">
              {{ formatRelative(acc.lastTest.atIso, now) }} · {{ formatDurationMs(acc.lastTest.durationMs) }}
            </p>
            <p v-if="scheduled?.has(acc.id)" class="mt-0.5 inline-flex items-center gap-1 text-2xs text-accent">
              <UiIcon name="clock" :size="10" />
              {{ t("accounts.schedule.badge", { n: scheduled.get(acc.id) }) }}
            </p>
          </td>

          <td v-if="visible.has('lastUsed')" class="whitespace-nowrap text-xs">
            <span v-if="acc.lastUsedAtIso" :title="acc.lastUsedAtIso">{{ formatRelative(acc.lastUsedAtIso, now) }}</span>
            <span v-else class="text-fg-subtle">{{ t("accounts.lastUsed.never") }}</span>
          </td>

          <td v-if="visible.has('expires')" class="whitespace-nowrap">
            <template v-if="acc.expiresAtIso">
              <p class="font-mono text-xs" :class="expiryState(acc, now) === 'ok' ? 'text-fg-muted' : ''">
                {{ formatDateShort(acc.expiresAtIso) }}
              </p>
              <UiBadge v-if="expiryState(acc, now) !== 'ok'" :tone="EXPIRY_TONE[expiryState(acc, now)]" class="mt-1">
                {{ expiryState(acc, now) === "expired" ? t("accounts.expiry.expired") : formatRelative(acc.expiresAtIso, now) }}
              </UiBadge>
            </template>
            <span v-else class="text-xs text-fg-subtle">{{ t("accounts.expiry.none") }}</span>
          </td>

          <td v-if="visible.has('created')" class="whitespace-nowrap font-mono text-xs text-fg-muted">
            {{ formatDateShort(acc.createdAtIso) }}
          </td>

          <td class="sticky-end whitespace-nowrap text-right">
            <div class="inline-flex items-center gap-0.5">
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-sm text-accent hover:!bg-accent/10"
                :disabled="acc.executionMode === 'vm_slot'"
                :title="acc.executionMode === 'vm_slot' ? t('accounts.row.vmTestDisabled') : t('accounts.row.test')"
                :aria-label="t('accounts.row.labelFor', { action: t('accounts.row.test'), name: acc.name })"
                @click="emit('test', acc)"
              >
                <UiIcon name="play" :size="13" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-sm"
                :title="t('accounts.row.edit')"
                :aria-label="t('accounts.row.labelFor', { action: t('accounts.row.edit'), name: acc.name })"
                @click="emit('edit', acc)"
              >
                <UiIcon name="pencil" :size="14" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-sm"
                aria-haspopup="menu"
                :title="t('accounts.row.more')"
                :aria-label="t('accounts.row.labelFor', { action: t('accounts.row.more'), name: acc.name })"
                @click="openMenu(acc, $event)"
              >
                <UiIcon name="more" :size="16" />
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/* Row actions stay reachable while the wide table scrolls horizontally. */
.sticky-end {
  position: sticky;
  right: 0;
  z-index: 1;
  background-color: rgb(var(--surface));
  box-shadow: inset 1px 0 0 rgb(var(--border));
}
thead .sticky-end {
  background-image: linear-gradient(rgb(var(--surface-2) / 0.6), rgb(var(--surface-2) / 0.6));
}
tbody tr:hover .sticky-end {
  background-image: linear-gradient(rgb(var(--surface-2) / 0.5), rgb(var(--surface-2) / 0.5));
}
tbody tr.is-selected .sticky-end {
  background-image: linear-gradient(rgb(var(--accent) / 0.06), rgb(var(--accent) / 0.06));
}

/* Dark cards are translucent (surface/70 over the page): layer the same mix so the pinned cell matches. */
.dark .sticky-end {
  background-color: rgb(var(--bg));
  background-image: linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
.dark thead .sticky-end {
  background-image:
    linear-gradient(rgb(var(--surface-2) / 0.4), rgb(var(--surface-2) / 0.4)),
    linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
.dark tbody tr:hover .sticky-end {
  background-image:
    linear-gradient(rgb(var(--surface-2) / 0.3), rgb(var(--surface-2) / 0.3)),
    linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
.dark tbody tr.is-selected .sticky-end {
  background-image:
    linear-gradient(rgb(var(--accent) / 0.06), rgb(var(--accent) / 0.06)),
    linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
</style>
