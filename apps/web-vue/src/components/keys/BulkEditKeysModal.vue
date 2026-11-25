<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem, BulkUpdateApiKeysRequest, GroupItem } from "@slipgate/contracts";
import { useNow } from "../../composables/useNow";
import { ApiError, apiJson, errorText } from "../../lib/api";
import { useToastStore } from "../../stores/toast";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import BulkField from "./BulkField.vue";
import ExpiryPicker from "./ExpiryPicker.vue";
import IpListField from "./IpListField.vue";
import UsdInput from "./UsdInput.vue";
import { WINDOWS, parseIpList, resolveExpiry, usdField, type ExpiryPreset, type WindowKey } from "./keyLimits";
import UiSelect from "../ui/UiSelect.vue";

/** Applies one patch to many keys (POST /bulk); only ticked fields are sent. */
const props = defineProps<{ keys: ApiKeyItem[]; groups: GroupItem[] }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "done", items: ApiKeyItem[]): void }>();

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(30_000);

const MAX_KEYS = 200;

type Field = "group" | "enabled" | "quota" | "windows" | "expiry" | "allow" | "deny" | "rate";
const tick = reactive<Record<Field, boolean>>({
  group: false,
  enabled: false,
  quota: false,
  windows: false,
  expiry: false,
  allow: false,
  deny: false,
  rate: false,
});

const form = reactive({
  groupId: "",
  enabled: true,
  quota: "0",
  windows: { "5h": "0", "1d": "0", "7d": "0" } as Record<WindowKey, string>,
  expiryPreset: "never" as ExpiryPreset,
  expiryCustom: "",
  ipAllow: "",
  ipDeny: "",
  rpm: 60 as number | string,
  concurrency: 5 as number | string,
});

const busy = ref(false);
const formError = ref<string | null>(null);
const failures = ref<{ keyId: string; name: string; message: string }[]>([]);
/** Keys this dialog was opened for (stable while the parent list refreshes). */
const targets = ref<ApiKeyItem[]>([]);

watch(
  open,
  (value) => {
    if (!value) return;
    (Object.keys(tick) as Field[]).forEach((k) => (tick[k] = false));
    targets.value = [...props.keys];
    form.groupId = props.groups[0]?.id ?? "";
    form.enabled = true;
    form.quota = "0";
    form.windows = { "5h": "0", "1d": "0", "7d": "0" };
    form.expiryPreset = "never";
    form.expiryCustom = "";
    form.ipAllow = "";
    form.ipDeny = "";
    form.rpm = 60;
    form.concurrency = 5;
    formError.value = null;
    failures.value = [];
  },
  { immediate: true },
);

const usd = computed(() => ({
  quota: usdField(form.quota),
  "5h": usdField(form.windows["5h"]),
  "1d": usdField(form.windows["1d"]),
  "7d": usdField(form.windows["7d"]),
}));
const allow = computed(() => parseIpList(form.ipAllow));
const deny = computed(() => parseIpList(form.ipDeny));
const expiry = computed(() => resolveExpiry(form.expiryPreset, form.expiryCustom, now.value));

function intIn(v: number | string, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
const rpm = computed(() => intIn(form.rpm, 1, 100_000));
const concurrency = computed(() => intIn(form.concurrency, 1, 1000));

const tickedCount = computed(() => Object.values(tick).filter(Boolean).length);

const blocking = computed<string | null>(() => {
  if (targets.value.length > MAX_KEYS) return t("user.bulk.tooMany", { n: MAX_KEYS });
  if (tick.group && !form.groupId) return t("user.bulk.groupRequired");
  if (tick.quota && usd.value.quota === null) return t("user.form.invalidUsd");
  if (tick.windows && WINDOWS.some((w) => usd.value[w] === null)) return t("user.form.invalidUsd");
  if (tick.expiry && !expiry.value.ok) return t(expiry.value.reason === "past" ? "user.form.expiryPast" : "user.form.expiryRequired");
  if (tick.allow && (allow.value.invalid.length || allow.value.tooMany)) {
    return t("user.bulk.ipInvalid", { field: t("user.form.ipAllowlist") });
  }
  if (tick.deny && (deny.value.invalid.length || deny.value.tooMany)) {
    return t("user.bulk.ipInvalid", { field: t("user.form.ipDenylist") });
  }
  if (tick.rate && (rpm.value === null || concurrency.value === null)) return t("user.form.rateInvalid");
  return null;
});

const preview = computed(() => targets.value.slice(0, 6));

function buildPatch(): BulkUpdateApiKeysRequest["patch"] {
  const patch: BulkUpdateApiKeysRequest["patch"] = {};
  if (tick.group) patch.groupId = form.groupId;
  if (tick.enabled) patch.enabled = form.enabled;
  if (tick.quota) patch.quotaUsd = usd.value.quota!;
  if (tick.windows) {
    patch.limit5hUsd = usd.value["5h"]!;
    patch.limit1dUsd = usd.value["1d"]!;
    patch.limit7dUsd = usd.value["7d"]!;
  }
  if (tick.expiry && expiry.value.ok) patch.expiresAtIso = expiry.value.iso;
  if (tick.allow) patch.ipAllowlist = allow.value.entries;
  if (tick.deny) patch.ipDenylist = deny.value.entries;
  if (tick.rate) {
    patch.rpmLimit = rpm.value!;
    patch.concurrencyLimit = concurrency.value!;
  }
  return patch;
}

async function submit() {
  formError.value = null;
  if (tickedCount.value === 0) {
    formError.value = t("user.bulk.nothing");
    return;
  }
  if (blocking.value || busy.value || targets.value.length === 0) return;
  busy.value = true;
  failures.value = [];
  try {
    const res = await apiJson<{ items: ApiKeyItem[]; failed: { keyId: string; message: string }[] }>(
      "/api/v1/user/api-keys/bulk",
      {
        method: "POST",
        body: { keyIds: targets.value.map((k) => k.id), patch: buildPatch() } satisfies BulkUpdateApiKeysRequest,
        fallbackError: t("user.errors.bulk"),
      },
    );
    if (res.items.length) emit("done", res.items);
    if (res.failed.length === 0) {
      toast.success(t("user.bulk.done", { n: res.items.length }));
      open.value = false;
      return;
    }
    const names = new Map(targets.value.map((k) => [k.id, k.name]));
    failures.value = res.failed.map((f) => ({ ...f, name: names.get(f.keyId) ?? f.keyId }));
    // Retry only what failed.
    const failedIds = new Set(res.failed.map((f) => f.keyId));
    targets.value = targets.value.filter((k) => failedIds.has(k.id));
    toast.warning(t("user.bulk.partial", { ok: res.items.length, failed: res.failed.length }));
  } catch (err) {
    formError.value =
      err instanceof ApiError && err.code === "invalid_request" ? t("user.errors.bulk") : errorText(err, t("user.errors.bulk"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" :title="t('user.bulk.title', { n: targets.length })" width="lg">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="sliders" :size="16" /></span>
    </template>

    <form id="bulk-key-form" class="space-y-3" novalidate @submit.prevent="submit">
      <div class="flex flex-wrap items-center gap-1.5">
        <span v-for="k in preview" :key="k.id" class="code-chip max-w-[10rem] truncate font-sans" :title="k.name">{{ k.name }}</span>
        <span v-if="targets.length > preview.length" class="text-2xs text-fg-subtle">
          {{ t("user.bulk.more", { n: targets.length - preview.length }) }}
        </span>
      </div>
      <p class="text-xs text-fg-subtle">{{ t("user.bulk.hint") }}</p>

      <UiAlert v-if="failures.length" tone="warning" :title="t('user.bulk.failedTitle')">
        <ul class="mt-1 space-y-0.5 text-xs">
          <li v-for="f in failures" :key="f.keyId" class="flex min-w-0 gap-2">
            <span class="shrink-0 font-medium text-fg">{{ f.name }}</span>
            <span class="min-w-0 truncate text-fg-muted" :title="f.message">{{ f.message }}</span>
          </li>
        </ul>
      </UiAlert>

      <BulkField id="bk-t-group" v-model:checked="tick.group" icon="layers" :label="t('user.bulk.fields.group')">
        <label for="bk-group" class="sr-only">{{ t("user.bulk.fields.group") }}</label>
        <UiSelect id="bk-group" v-model="form.groupId" class="select">
          <option v-for="g in groups" :key="g.id" :value="g.id">
            {{ g.name }} · {{ g.platform }}{{ g.rateMultiplier !== 1 ? ` · ×${g.rateMultiplier}` : "" }}
          </option>
        </UiSelect>
      </BulkField>

      <BulkField id="bk-t-enabled" v-model:checked="tick.enabled" icon="play" :label="t('user.bulk.fields.enabled')">
        <UiSwitch v-model="form.enabled" :label="form.enabled ? t('common.enabled') : t('common.disabled')" />
      </BulkField>

      <BulkField
        id="bk-t-quota"
        v-model:checked="tick.quota"
        icon="wallet"
        :label="t('user.bulk.fields.quota')"
        :hint="t('user.form.zeroUnlimited')"
      >
        <div class="max-w-xs">
          <UsdInput id="bk-quota" v-model="form.quota" :invalid="tick.quota && usd.quota === null" :aria-label="t('user.form.quota')" />
        </div>
      </BulkField>

      <BulkField
        id="bk-t-windows"
        v-model:checked="tick.windows"
        icon="clock"
        :label="t('user.bulk.fields.windows')"
        :hint="t('user.form.zeroUnlimited')"
      >
        <div class="grid gap-3 sm:grid-cols-3">
          <div v-for="w in WINDOWS" :key="w" class="min-w-0">
            <label :for="`bk-w${w}`" class="label">{{ t(`user.form.windowLimit.${w}`) }}</label>
            <UsdInput :id="`bk-w${w}`" v-model="form.windows[w]" :invalid="tick.windows && usd[w] === null" />
          </div>
        </div>
      </BulkField>

      <BulkField id="bk-t-expiry" v-model:checked="tick.expiry" icon="calendar" :label="t('user.bulk.fields.expiry')">
        <ExpiryPicker
          id="bk-expiry"
          v-model:preset="form.expiryPreset"
          v-model:custom="form.expiryCustom"
          :result="expiry"
          :now="now"
        />
      </BulkField>

      <BulkField id="bk-t-rate" v-model:checked="tick.rate" icon="gauge" :label="t('user.bulk.fields.rate')">
        <div class="grid grid-cols-2 gap-3">
          <div class="min-w-0">
            <label for="bk-rpm" class="label">{{ t("user.form.rpm") }}</label>
            <input id="bk-rpm" v-model.number="form.rpm" type="number" min="1" max="100000" class="input font-mono" />
          </div>
          <div class="min-w-0">
            <label for="bk-conc" class="label">{{ t("user.form.concurrency") }}</label>
            <input id="bk-conc" v-model.number="form.concurrency" type="number" min="1" max="1000" class="input font-mono" />
          </div>
        </div>
      </BulkField>

      <BulkField id="bk-t-allow" v-model:checked="tick.allow" icon="shield" :label="t('user.bulk.fields.ipAllowlist')">
        <IpListField id="bk-allow" v-model="form.ipAllow" :label="t('user.form.ipAllowlist')" :hint="t('user.bulk.ipReplace')" />
      </BulkField>

      <BulkField id="bk-t-deny" v-model:checked="tick.deny" icon="shield-alert" :label="t('user.bulk.fields.ipDenylist')">
        <IpListField id="bk-deny" v-model="form.ipDeny" :label="t('user.form.ipDenylist')" :hint="t('user.bulk.ipReplace')" />
      </BulkField>

      <UiAlert v-if="formError" tone="danger">{{ formError }}</UiAlert>
    </form>

    <template #footer>
      <span v-if="blocking && tickedCount > 0" class="mr-auto hidden min-w-0 truncate text-xs text-danger sm:inline">{{ blocking }}</span>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">
        {{ failures.length ? t("common.close") : t("common.cancel") }}
      </button>
      <button
        type="submit"
        form="bulk-key-form"
        class="btn btn-primary"
        :disabled="busy || Boolean(blocking) || targets.length === 0"
      >
        <UiIcon :name="busy ? 'loader' : 'check'" :size="15" :spin="busy" />
        {{ failures.length ? t("user.bulk.retry", { n: targets.length }) : t("user.bulk.submit", { n: targets.length }) }}
      </button>
    </template>
  </UiModal>
</template>
