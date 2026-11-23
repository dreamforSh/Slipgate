<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminAdjustBalanceRequest, AdminUserItem, BalanceOperation } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatUsd } from "../../../lib/format";
import { USD_INPUT_PATTERN, normalizeUsdInput, parseUsdToNano } from "./money";
import { displayName } from "./userDisplay";

/** Add / subtract / set a wallet balance with a live preview of the result. */
const props = defineProps<{ user: AdminUserItem | null }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "adjusted", user: AdminUserItem, balanceNanoUsd: string, deltaNanoUsd: string): void }>();

const { t } = useI18n();

const operation = ref<BalanceOperation>("add");
const amount = ref("");
const reason = ref("");
const saving = ref(false);
const error = ref<string | null>(null);

watch(open, (isOpen) => {
  if (!isOpen) return;
  operation.value = "add";
  amount.value = "";
  reason.value = "";
  error.value = null;
});

const opOptions = computed<{ value: BalanceOperation; label: string }[]>(() => [
  { value: "add", label: t("adminUsers.balance.ops.add") },
  { value: "subtract", label: t("adminUsers.balance.ops.subtract") },
  { value: "set", label: t("adminUsers.balance.ops.set") },
]);

const current = computed(() => {
  try {
    return BigInt(props.user?.balanceNanoUsd ?? "0");
  } catch {
    return 0n;
  }
});
const amountNano = computed(() => (amount.value.trim() ? parseUsdToNano(amount.value) : null));
const invalid = computed(() => amount.value.trim() !== "" && amountNano.value === null);

const next = computed<bigint | null>(() => {
  const a = amountNano.value;
  if (a === null) return null;
  if (operation.value === "add") return current.value + a;
  if (operation.value === "subtract") return current.value - a;
  return a;
});
const delta = computed(() => (next.value === null ? null : next.value - current.value));
const negative = computed(() => next.value !== null && next.value < 0n);
const deltaSign = computed(() => (delta.value === null ? 0 : delta.value > 0n ? 1 : delta.value < 0n ? -1 : 0));

/** formatUsd takes non-negative nano strings; render the sign ourselves. */
function signed(n: bigint): string {
  if (n === 0n) return formatUsd("0");
  return `${n < 0n ? "−" : "+"}${formatUsd((n < 0n ? -n : n).toString())}`;
}
function money(n: bigint): string {
  return n < 0n ? `−${formatUsd((-n).toString())}` : formatUsd(n.toString());
}

const icon = computed(() => (operation.value === "add" ? "plus" : operation.value === "subtract" ? "arrow-down" : "pencil"));

async function submit() {
  const u = props.user;
  const normalized = normalizeUsdInput(amount.value);
  if (!u || saving.value || normalized === null) return;
  error.value = null;
  saving.value = true;
  try {
    const body: AdminAdjustBalanceRequest = { operation: operation.value, amountUsd: normalized, reason: reason.value.trim() };
    const res = await apiJson<{ balanceNanoUsd: string; deltaNanoUsd: string }>(
      `/api/v1/admin/users/${encodeURIComponent(u.id)}/balance`,
      { method: "POST", body, fallbackError: t("adminUsers.errors.balance") },
    );
    emit("adjusted", u, res.balanceNanoUsd, res.deltaNanoUsd);
    open.value = false;
  } catch (err) {
    error.value = errorText(err, t("adminUsers.errors.balance"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" width="md" :persistent="saving" :title="t('adminUsers.balance.title')">
    <template #icon>
      <span class="icon-chip icon-chip-success h-8 w-8">
        <UiIcon name="wallet" :size="15" />
      </span>
    </template>

    <form v-if="user" id="admin-user-balance" class="space-y-4" @submit.prevent="submit">
      <UiAlert v-if="error" tone="danger" class="animate-fade-in">{{ error }}</UiAlert>

      <div class="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium text-fg">{{ displayName(user) }}</p>
          <p class="truncate text-xs text-fg-subtle">{{ user.email }}</p>
        </div>
        <div class="shrink-0 text-right">
          <p class="text-2xs text-fg-subtle">{{ t("adminUsers.balance.current") }}</p>
          <p class="font-mono text-sm font-semibold tabular-nums text-fg">{{ money(current) }}</p>
        </div>
      </div>

      <div>
        <p class="label">{{ t("adminUsers.balance.operation") }}</p>
        <SegmentedControl v-model="operation" :options="opOptions" size="md" block />
      </div>

      <FormField :label="t('adminUsers.balance.amount')" required>
        <div class="relative">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-fg-subtle">$</span>
          <input
            v-model="amount"
            type="text"
            inputmode="decimal"
            required
            :pattern="USD_INPUT_PATTERN"
            autocomplete="off"
            :placeholder="t('adminUsers.balance.amountPlaceholder')"
            class="input pl-7 font-mono"
            :class="invalid ? '!border-danger focus:!ring-danger/20' : ''"
          />
        </div>
        <span v-if="invalid" class="hint block !text-danger">{{ t("adminUsers.balance.invalidAmount") }}</span>
      </FormField>

      <FormField :label="t('adminUsers.balance.reason')">
        <input
          v-model="reason"
          type="text"
          maxlength="200"
          :placeholder="t('adminUsers.balance.reasonPlaceholder')"
          class="input"
        />
      </FormField>

      <div
        class="overflow-hidden rounded-lg border transition-colors duration-200"
        :class="negative ? 'border-danger/30 bg-danger/[0.05]' : 'border-accent/20 bg-accent/[0.04]'"
      >
        <div class="flex items-center justify-between gap-3 px-3.5 py-3">
          <div class="flex min-w-0 items-center gap-2.5">
            <span class="icon-chip h-7 w-7" :class="negative ? 'icon-chip-danger' : 'icon-chip-accent'">
              <UiIcon :name="icon" :size="14" />
            </span>
            <div class="min-w-0">
              <p class="text-xs text-fg-subtle">{{ t("adminUsers.balance.preview") }}</p>
              <p
                v-if="delta !== null"
                class="font-mono text-2xs tabular-nums"
                :class="deltaSign > 0 ? 'text-success' : deltaSign < 0 ? 'text-danger' : 'text-fg-subtle'"
              >
                {{ t("adminUsers.balance.delta", { amount: signed(delta) }) }}
              </p>
            </div>
          </div>
          <p
            class="font-mono text-lg font-semibold tabular-nums transition-colors"
            :class="next === null ? 'text-fg-subtle' : negative ? 'text-danger' : 'text-fg'"
          >
            {{ next === null ? "—" : money(next) }}
          </p>
        </div>
        <p
          v-if="negative"
          class="flex items-center gap-1.5 border-t border-danger/20 px-3.5 py-2 text-xs text-danger animate-fade-in"
        >
          <UiIcon name="alert" :size="13" />
          {{ t("adminUsers.balance.negative") }}
        </p>
      </div>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="open = false">
        {{ t("common.cancel") }}
      </button>
      <button
        type="submit"
        form="admin-user-balance"
        class="btn btn-primary"
        :disabled="saving || amountNano === null"
      >
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ t("adminUsers.balance.submit") }}
      </button>
    </template>
  </UiModal>
</template>
