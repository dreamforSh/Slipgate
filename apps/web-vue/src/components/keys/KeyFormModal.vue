<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem, CreatedApiKeyResponse, GroupItem, UpdateApiKeyRequest, UserGroupRatesResponse } from "@slipgate/contracts";
import { useNow } from "../../composables/useNow";
import { ApiError, apiJson, errorText } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";
import ConfirmButton from "../ui/ConfirmButton.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import ExpiryPicker from "./ExpiryPicker.vue";
import IpListField from "./IpListField.vue";
import LimitBar from "./LimitBar.vue";
import UsdInput from "./UsdInput.vue";
import {
  WINDOWS,
  isZeroNano,
  isoToLocalInput,
  limitInput,
  parseIpList,
  resolveExpiry,
  sameList,
  usdField,
  windowOf,
  type ExpiryPreset,
  type WindowKey,
} from "./keyLimits";
import UiSelect from "../ui/UiSelect.vue";

/**
 * Create (apiKey = null) or edit an API key: limits, expiry, IP rules and rate limits.
 * `limits` (the user's rates and caps) adds the account / group ceilings next to the key's own
 * RPM and concurrency; on create, empty RPM / concurrency take the portal defaults server-side.
 */
const props = defineProps<{ apiKey: ApiKeyItem | null; groups: GroupItem[]; limits?: UserGroupRatesResponse | null }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{
  (e: "created", res: CreatedApiKeyResponse): void;
  (e: "saved", item: ApiKeyItem): void;
  /** Usage counters were reset from inside the dialog (it stays open). */
  (e: "updated", item: ApiKeyItem): void;
}>();

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(30_000);

const CUSTOM_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

const isEdit = computed(() => props.apiKey !== null);
/** Live copy of the edited key so usage reflects resets made in this dialog. */
const current = ref<ApiKeyItem | null>(null);

const form = reactive({
  name: "",
  groupId: "",
  rpm: "" as number | string,
  concurrency: "" as number | string,
  customOn: false,
  customKey: "",
  quota: "0",
  windows: { "5h": "0", "1d": "0", "7d": "0" } as Record<WindowKey, string>,
  expiryPreset: "never" as ExpiryPreset,
  expiryCustom: "",
  ipAllow: "",
  ipDeny: "",
});

const submitted = ref(false);
const busy = ref(false);
const resetting = ref<"quota" | "windows" | null>(null);
const formError = ref<string | null>(null);

function reset() {
  const k = props.apiKey;
  current.value = k ? { ...k } : null;
  form.name = k?.name ?? "";
  form.groupId = k?.groupId ?? props.groups[0]?.id ?? "";
  // New keys leave these empty: the server applies the portal defaults (Settings).
  form.rpm = k?.rpmLimit ?? "";
  form.concurrency = k?.concurrencyLimit ?? "";
  form.customOn = false;
  form.customKey = "";
  form.quota = limitInput(k?.quotaNanoUsd);
  form.windows = {
    "5h": limitInput(k?.limit5hNanoUsd),
    "1d": limitInput(k?.limit1dNanoUsd),
    "7d": limitInput(k?.limit7dNanoUsd),
  };
  form.expiryPreset = k?.expiresAtIso ? "custom" : "never";
  form.expiryCustom = isoToLocalInput(k?.expiresAtIso);
  form.ipAllow = (k?.ipAllowlist ?? []).join("\n");
  form.ipDeny = (k?.ipDenylist ?? []).join("\n");
  submitted.value = false;
  formError.value = null;
}

watch(
  open,
  (value) => {
    if (value) reset();
    else form.customKey = ""; // never keep a typed key around after the dialog closes
  },
  { immediate: true },
);

// Groups can arrive after the dialog opened.
watch(
  () => props.groups,
  (groups) => {
    if (!form.groupId && groups[0]) form.groupId = groups[0].id;
  },
);

/* ---------------- Validation ---------------- */

const groupMissing = computed(() => Boolean(props.apiKey) && !props.groups.some((g) => g.id === props.apiKey?.groupId));
const selectedGroup = computed(() => props.groups.find((g) => g.id === form.groupId) ?? null);

const nameError = computed(() => {
  const n = form.name.trim();
  if (n.length > 64) return t("user.form.nameTooLong");
  if (!n && submitted.value) return t("user.form.nameRequired");
  return null;
});
const nameInvalid = computed(() => !form.name.trim() || form.name.trim().length > 64);

const customKeyInvalid = computed(() => form.customOn && !CUSTOM_KEY_RE.test(form.customKey.trim()));
const customKeyError = computed(() =>
  customKeyInvalid.value && (submitted.value || form.customKey.trim().length > 0) ? t("user.form.customKeyInvalid") : null,
);

const usd = computed(() => ({
  quota: usdField(form.quota),
  "5h": usdField(form.windows["5h"]),
  "1d": usdField(form.windows["1d"]),
  "7d": usdField(form.windows["7d"]),
}));
const usdInvalid = computed(() => Object.values(usd.value).some((v) => v === null));

const allow = computed(() => parseIpList(form.ipAllow));
const deny = computed(() => parseIpList(form.ipDeny));
const ipInvalid = computed(
  () => allow.value.invalid.length > 0 || deny.value.invalid.length > 0 || allow.value.tooMany || deny.value.tooMany,
);

const originalExpiryLocal = computed(() => isoToLocalInput(props.apiKey?.expiresAtIso));
/** Editing without touching a past expiry must not be blocked by the "future" rule. */
const expiryUntouched = computed(
  () => isEdit.value && form.expiryPreset === "custom" && form.expiryCustom === originalExpiryLocal.value && Boolean(originalExpiryLocal.value),
);
const expiry = computed(() => resolveExpiry(form.expiryPreset, form.expiryCustom, now.value, expiryUntouched.value));

function intIn(v: number | string, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
const rpm = computed(() => intIn(form.rpm, 1, 100_000));
const concurrency = computed(() => intIn(form.concurrency, 1, 1000));
/** Create only: an empty field means "portal default" and is left out of the request. */
const rpmDefault = computed(() => !isEdit.value && String(form.rpm).trim() === "");
const concurrencyDefault = computed(() => !isEdit.value && String(form.concurrency).trim() === "");
const rpmOk = computed(() => rpm.value !== null || rpmDefault.value);
const concurrencyOk = computed(() => concurrency.value !== null || concurrencyDefault.value);

/* ---------------- Account / group ceilings (lane U1) ---------------- */

const groupRate = computed(() => props.limits?.items.find((i) => i.groupId === form.groupId) ?? null);
function capWord(n: number, kind: "rpm" | "concurrency"): string {
  return kind === "rpm" ? t("userLimits.cap.rpm", { n }) : t("userLimits.cap.concurrency", { n });
}
/** "Account cap 60 RPM · group cap 30 RPM" for the key's RPM / concurrency hints. */
function ceilingText(kind: "rpm" | "concurrency"): string | null {
  const l = props.limits;
  if (!l) return null;
  const parts: string[] = [];
  const account = kind === "rpm" ? l.userRpmLimit : l.userConcurrencyLimit;
  const group = kind === "rpm" ? groupRate.value?.rpmLimit ?? 0 : groupRate.value?.concurrencyLimit ?? 0;
  if (account > 0) parts.push(t("userLimits.keyForm.accountCap", { value: capWord(account, kind) }));
  if (group > 0) parts.push(t("userLimits.keyForm.groupCap", { value: capWord(group, kind) }));
  return parts.length ? parts.join(" · ") : null;
}
const rpmCeiling = computed(() => ceilingText("rpm"));
const concurrencyCeiling = computed(() => ceilingText("concurrency"));

const valid = computed(
  () =>
    !nameInvalid.value &&
    Boolean(form.groupId) &&
    !customKeyInvalid.value &&
    !usdInvalid.value &&
    !ipInvalid.value &&
    expiry.value.ok &&
    rpmOk.value &&
    concurrencyOk.value,
);

/* ---------------- Submit ---------------- */

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code === "invalid_request") return fallback;
  return errorText(err, fallback);
}

function buildPatch(k: ApiKeyItem): UpdateApiKeyRequest {
  const patch: UpdateApiKeyRequest = {};
  const name = form.name.trim();
  if (name !== k.name) patch.name = name;
  if (form.groupId !== k.groupId) patch.groupId = form.groupId;
  if (rpm.value !== k.rpmLimit) patch.rpmLimit = rpm.value!;
  if (concurrency.value !== k.concurrencyLimit) patch.concurrencyLimit = concurrency.value!;
  if (usd.value.quota !== limitInput(k.quotaNanoUsd)) patch.quotaUsd = usd.value.quota!;
  if (usd.value["5h"] !== limitInput(k.limit5hNanoUsd)) patch.limit5hUsd = usd.value["5h"]!;
  if (usd.value["1d"] !== limitInput(k.limit1dNanoUsd)) patch.limit1dUsd = usd.value["1d"]!;
  if (usd.value["7d"] !== limitInput(k.limit7dNanoUsd)) patch.limit7dUsd = usd.value["7d"]!;
  if (!sameList(allow.value.entries, k.ipAllowlist)) patch.ipAllowlist = allow.value.entries;
  if (!sameList(deny.value.entries, k.ipDenylist ?? [])) patch.ipDenylist = deny.value.entries;
  if (expiry.value.ok && !expiryUntouched.value) {
    const next = expiry.value.iso;
    if (next !== null || k.expiresAtIso !== null) patch.expiresAtIso = next;
  }
  return patch;
}

async function submit() {
  submitted.value = true;
  formError.value = null;
  if (!valid.value) {
    await nextTick();
    document.querySelector<HTMLElement>('#key-form [aria-invalid="true"]')?.focus();
    return;
  }
  if (busy.value || !expiry.value.ok) return;
  busy.value = true;
  try {
    const k = props.apiKey;
    if (!k) {
      const res = await apiJson<CreatedApiKeyResponse>("/api/v1/user/api-keys", {
        method: "POST",
        fallbackError: t("user.errors.create"),
        body: {
          name: form.name.trim(),
          groupId: form.groupId,
          ...(rpmDefault.value ? {} : { rpmLimit: rpm.value }),
          ...(concurrencyDefault.value ? {} : { concurrencyLimit: concurrency.value }),
          ipAllowlist: allow.value.entries,
          ipDenylist: deny.value.entries,
          expiresAtIso: expiry.value.iso,
          quotaUsd: usd.value.quota,
          limit5hUsd: usd.value["5h"],
          limit1dUsd: usd.value["1d"],
          limit7dUsd: usd.value["7d"],
          ...(form.customOn ? { customKey: form.customKey.trim() } : {}),
        },
      });
      form.customKey = "";
      emit("created", res);
      open.value = false;
      return;
    }
    const patch = buildPatch(k);
    if (Object.keys(patch).length === 0) {
      open.value = false;
      return;
    }
    const res = await apiJson<{ item: ApiKeyItem }>(`/api/v1/user/api-keys/${encodeURIComponent(k.id)}`, {
      method: "PATCH",
      body: patch,
      fallbackError: t("user.errors.update"),
    });
    emit("saved", res.item);
    open.value = false;
  } catch (err) {
    formError.value = messageOf(err, isEdit.value ? t("user.errors.update") : t("user.errors.create"));
  } finally {
    busy.value = false;
  }
}

async function resetUsage(kind: "quota" | "windows") {
  const k = current.value;
  if (!k || resetting.value) return;
  resetting.value = kind;
  try {
    const res = await apiJson<{ item: ApiKeyItem }>(`/api/v1/user/api-keys/${encodeURIComponent(k.id)}`, {
      method: "PATCH",
      body: kind === "quota" ? { resetQuota: true } : { resetWindows: true },
      fallbackError: t("user.errors.update"),
    });
    current.value = res.item;
    emit("updated", res.item);
    toast.success(kind === "quota" ? t("user.form.resetQuotaDone") : t("user.form.resetWindowsDone"));
  } catch (err) {
    toast.error(messageOf(err, t("user.errors.update")));
  } finally {
    resetting.value = null;
  }
}

const windowUsageZero = computed(() => !current.value || WINDOWS.every((w) => isZeroNano(windowOf(current.value!, w).used)));
const invalidClass = "!border-danger/60 focus:!ring-danger/20";
</script>

<template>
  <UiModal
    v-model:open="open"
    :title="isEdit ? t('user.form.editTitle', { name: apiKey?.name ?? '' }) : t('user.form.createTitle')"
    width="lg"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="isEdit ? 'pencil' : 'key'" :size="16" />
      </span>
    </template>

    <form id="key-form" class="space-y-6" novalidate @submit.prevent="submit">
      <!-- Basics -->
      <section class="space-y-4">
        <p class="eyebrow">{{ t("user.form.sections.basic") }}</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="min-w-0">
            <label for="kf-name" class="label">{{ t("user.form.name") }} <span class="text-danger">*</span></label>
            <input
              id="kf-name"
              v-model="form.name"
              type="text"
              maxlength="80"
              autocomplete="off"
              :placeholder="t('user.form.namePlaceholder')"
              class="input"
              :class="nameError ? invalidClass : ''"
              :aria-invalid="Boolean(nameError) || (submitted && nameInvalid) || undefined"
            />
            <p v-if="nameError" class="mt-1 animate-fade-in text-xs text-danger">{{ nameError }}</p>
          </div>
          <div class="min-w-0">
            <label for="kf-group" class="label">{{ t("user.form.group") }} <span class="text-danger">*</span></label>
            <UiSelect id="kf-group" v-model="form.groupId" class="select" :aria-invalid="(submitted && !form.groupId) || undefined">
              <option v-if="groupMissing && apiKey" :value="apiKey.groupId" disabled>
                {{ t("user.keys.groupUnavailable", { name: apiKey.groupName }) }}
              </option>
              <option v-for="g in groups" :key="g.id" :value="g.id">
                {{ g.name }} · {{ g.platform }}{{ g.rateMultiplier !== 1 ? ` · ×${g.rateMultiplier}` : "" }}
              </option>
            </UiSelect>
            <p
              v-if="groupRate && groupRate.customRateMultiplier !== null"
              class="mt-1 flex items-center gap-1 text-xs"
              :class="groupRate.effectiveRateMultiplier <= groupRate.groupRateMultiplier ? 'text-success' : 'text-warning'"
            >
              <UiIcon name="percent" :size="12" />
              {{
                t("userLimits.keyForm.customRate", {
                  rate: Number(groupRate.effectiveRateMultiplier.toFixed(4)),
                  list: Number(groupRate.groupRateMultiplier.toFixed(4)),
                })
              }}
            </p>
            <p v-else-if="selectedGroup?.description" class="hint truncate" :title="selectedGroup.description">
              {{ selectedGroup.description }}
            </p>
          </div>
          <div class="min-w-0">
            <label for="kf-rpm" class="label">{{ t("user.form.rpm") }}</label>
            <input
              id="kf-rpm"
              v-model.number="form.rpm"
              type="number"
              min="1"
              max="100000"
              step="1"
              :placeholder="isEdit ? undefined : t('userLimits.keyForm.defaultPlaceholder')"
              class="input font-mono"
              :class="!rpmOk ? invalidClass : ''"
              :aria-invalid="!rpmOk || undefined"
              :aria-describedby="rpmCeiling || rpmDefault ? 'kf-rpm-hint' : undefined"
            />
            <p v-if="rpmCeiling || rpmDefault" id="kf-rpm-hint" class="hint">
              {{ [rpmDefault ? t("userLimits.keyForm.defaultHint") : "", rpmCeiling ?? ""].filter(Boolean).join(" · ") }}
            </p>
          </div>
          <div class="min-w-0">
            <label for="kf-conc" class="label">{{ t("user.form.concurrency") }}</label>
            <input
              id="kf-conc"
              v-model.number="form.concurrency"
              type="number"
              min="1"
              max="1000"
              step="1"
              :placeholder="isEdit ? undefined : t('userLimits.keyForm.defaultPlaceholder')"
              class="input font-mono"
              :class="!concurrencyOk ? invalidClass : ''"
              :aria-invalid="!concurrencyOk || undefined"
              :aria-describedby="concurrencyCeiling || concurrencyDefault ? 'kf-conc-hint' : undefined"
            />
            <p v-if="concurrencyCeiling || concurrencyDefault" id="kf-conc-hint" class="hint">
              {{ [concurrencyDefault ? t("userLimits.keyForm.defaultHint") : "", concurrencyCeiling ?? ""].filter(Boolean).join(" · ") }}
            </p>
          </div>
        </div>

        <div v-if="!isEdit" class="rounded-lg border border-line/80 bg-surface-2/40 p-3.5">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-medium text-fg">{{ t("user.form.customKey") }}</p>
              <p class="mt-0.5 text-xs text-fg-subtle">{{ t("user.form.customKeyHint") }}</p>
            </div>
            <UiSwitch v-model="form.customOn" :label="t('user.form.customKey')" hide-label tone="accent" />
          </div>
          <Transition
            enter-active-class="transition duration-200 ease-out"
            leave-active-class="transition duration-150 ease-in"
            enter-from-class="-translate-y-1 opacity-0"
            leave-to-class="-translate-y-1 opacity-0"
          >
            <div v-if="form.customOn" class="mt-3">
              <label for="kf-custom" class="sr-only">{{ t("user.form.customKey") }}</label>
              <input
                id="kf-custom"
                v-model="form.customKey"
                type="text"
                maxlength="128"
                autocomplete="off"
                spellcheck="false"
                :placeholder="t('user.form.customKeyPlaceholder')"
                class="input font-mono text-xs"
                :class="customKeyError ? invalidClass : ''"
                :aria-invalid="Boolean(customKeyError) || (submitted && customKeyInvalid) || undefined"
              />
              <p class="mt-1 flex items-center justify-between gap-2 text-xs">
                <span :class="customKeyError ? 'text-danger' : 'text-fg-subtle'">
                  {{ customKeyError ?? t("user.form.customKeyRule") }}
                </span>
                <span class="shrink-0 font-mono tabular-nums text-fg-subtle">{{ form.customKey.trim().length }}</span>
              </p>
            </div>
          </Transition>
        </div>
      </section>

      <!-- Spend limits -->
      <section class="space-y-4 border-t border-line/70 pt-5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="eyebrow">{{ t("user.form.sections.limits") }}</p>
          <span class="text-2xs text-fg-subtle">{{ t("user.form.zeroUnlimited") }}</span>
        </div>

        <div class="grid gap-4" :class="current ? 'sm:grid-cols-2' : ''">
          <div class="min-w-0">
            <label for="kf-quota" class="label">{{ t("user.form.quota") }}</label>
            <UsdInput id="kf-quota" v-model="form.quota" :invalid="usd.quota === null" />
            <p class="mt-1 text-xs" :class="usd.quota === null ? 'text-danger' : 'text-fg-subtle'">
              {{ usd.quota === null ? t("user.form.invalidUsd") : t("user.form.quotaHint") }}
            </p>
          </div>
          <div v-if="current" class="min-w-0 rounded-lg border border-line/70 bg-surface-2/40 p-3">
            <LimitBar :label="t('user.form.currentUsage')" :used="current.spentNanoUsd" :limit="current.quotaNanoUsd" />
            <div class="mt-2 flex justify-end">
              <ConfirmButton
                icon="rotate-ccw"
                :label="t('user.form.resetQuota')"
                :confirm-label="t('user.form.resetConfirm')"
                :disabled="resetting !== null || isZeroNano(current.spentNanoUsd)"
                @confirm="resetUsage('quota')"
              />
            </div>
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-3">
          <div v-for="w in WINDOWS" :key="w" class="min-w-0">
            <label :for="`kf-w${w}`" class="label">{{ t(`user.form.windowLimit.${w}`) }}</label>
            <UsdInput :id="`kf-w${w}`" v-model="form.windows[w]" :invalid="usd[w] === null" />
            <p v-if="usd[w] === null" class="mt-1 text-xs text-danger">{{ t("user.form.invalidUsd") }}</p>
            <p v-else-if="current" class="mt-1 font-mono text-2xs tabular-nums text-fg-subtle">
              {{ t("user.form.used", { amount: formatUsd(windowOf(current, w).used) }) }}
            </p>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-fg-subtle">{{ t("user.form.windowsHint") }}</p>
          <ConfirmButton
            v-if="current"
            icon="rotate-ccw"
            :label="t('user.form.resetWindows')"
            :confirm-label="t('user.form.resetConfirm')"
            :disabled="resetting !== null || windowUsageZero"
            @confirm="resetUsage('windows')"
          />
        </div>
      </section>

      <!-- Expiry -->
      <section class="space-y-3 border-t border-line/70 pt-5">
        <p class="eyebrow">{{ t("user.form.sections.expiry") }}</p>
        <ExpiryPicker
          id="kf-expiry"
          v-model:preset="form.expiryPreset"
          v-model:custom="form.expiryCustom"
          :result="expiry"
          :now="now"
        />
      </section>

      <!-- Access -->
      <section class="space-y-3 border-t border-line/70 pt-5">
        <p class="eyebrow">{{ t("user.form.sections.access") }}</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <IpListField id="kf-allow" v-model="form.ipAllow" :label="t('user.form.ipAllowlist')" :hint="t('user.form.ipAllowlistHint')" />
          <IpListField id="kf-deny" v-model="form.ipDeny" :label="t('user.form.ipDenylist')" :hint="t('user.form.ipDenylistHint')" />
        </div>
      </section>

      <UiAlert v-if="formError" tone="danger">{{ formError }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
      <button type="submit" form="key-form" class="btn btn-primary" :disabled="busy || !form.groupId">
        <UiIcon :name="busy ? 'loader' : isEdit ? 'check' : 'plus'" :size="15" :spin="busy" />
        {{ busy ? t("common.saving") : isEdit ? t("user.form.save") : t("user.form.submit") }}
      </button>
    </template>
  </UiModal>
</template>
