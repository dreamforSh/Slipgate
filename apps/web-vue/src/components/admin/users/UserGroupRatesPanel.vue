<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { AdminUserGroupRateItem, AdminUserGroupRatesResponse, AdminUserItem, SetUserGroupRatesRequest } from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import EmptyState from "../../ui/EmptyState.vue";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { fmtRate, parseLimit, parseRate, useLimitText } from "./limits";

/**
 * One user's custom multiplier and RPM override per group (Linksyncx UserAllowedGroupsModal
 * group_rates). Empty input = the group's own value. Saves only the groups that changed.
 */
const props = defineProps<{ user: AdminUserItem; active: boolean }>();
const emit = defineEmits<{ (e: "saved"): void }>();

const { t, capText, errorOf } = useLimitText();
const toast = useToastStore();

const items = ref<AdminUserGroupRateItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const search = ref("");
const onlyCustom = ref(false);

/** Typed text per group: "" = no custom value. */
const rateText = reactive<Record<string, string>>({});
// type="number" inputs hand back numbers once a value parses (Vue casts them).
const rpmText = reactive<Record<string, string | number>>({});

function fill(list: AdminUserGroupRateItem[]) {
  items.value = list;
  for (const k of Object.keys(rateText)) delete rateText[k];
  for (const k of Object.keys(rpmText)) delete rpmText[k];
  for (const g of list) {
    rateText[g.groupId] = g.rateMultiplier === null ? "" : String(g.rateMultiplier);
    rpmText[g.groupId] = g.rpmOverride === null ? "" : String(g.rpmOverride);
  }
}

let seq = 0;
async function load() {
  const id = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await apiJson<AdminUserGroupRatesResponse>(`/api/v1/admin/users/${encodeURIComponent(props.user.id)}/group-rates`);
    if (id !== seq) return;
    fill(res.items);
    loaded.value = true;
  } catch (err) {
    if (id === seq) loadError.value = errorOf(err, t("userLimits.rates.loadFailed"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch(
  () => [props.active, props.user.id] as const,
  ([active], prev) => {
    const userChanged = prev && prev[1] !== props.user.id;
    if (userChanged) {
      loaded.value = false;
      fill([]);
    }
    if (active && (!loaded.value || userChanged)) void load();
  },
  { immediate: true },
);

/* ---------------- Drafts ---------------- */

const rateInvalid = (gid: string) => rateText[gid]?.trim() !== "" && parseRate(rateText[gid] ?? "") === null;
const rpmRaw = (gid: string) => String(rpmText[gid] ?? "").trim();
const rpmInvalid = (gid: string) => rpmRaw(gid) !== "" && parseLimit(rpmRaw(gid)) === null;
const draftRate = (gid: string) => (rateText[gid]?.trim() ? parseRate(rateText[gid]!) : null);
const draftRpm = (gid: string) => (rpmRaw(gid) ? parseLimit(rpmRaw(gid)) : null);

const changes = computed(() => {
  const rates: Record<string, number | null> = {};
  const rpmOverrides: Record<string, number | null> = {};
  for (const g of items.value) {
    if (rateInvalid(g.groupId) || rpmInvalid(g.groupId)) continue;
    const r = draftRate(g.groupId);
    const o = draftRpm(g.groupId);
    if (r !== g.rateMultiplier) rates[g.groupId] = r;
    if (o !== g.rpmOverride) rpmOverrides[g.groupId] = o;
  }
  return { rates, rpmOverrides };
});
const changedCount = computed(() => new Set([...Object.keys(changes.value.rates), ...Object.keys(changes.value.rpmOverrides)]).size);
const anyInvalid = computed(() => items.value.some((g) => rateInvalid(g.groupId) || rpmInvalid(g.groupId)));
const isChanged = (g: AdminUserGroupRateItem) => g.groupId in changes.value.rates || g.groupId in changes.value.rpmOverrides;

function discard() {
  fill(items.value);
  saveError.value = null;
}

function clearRow(g: AdminUserGroupRateItem) {
  rateText[g.groupId] = "";
  rpmText[g.groupId] = "";
}

async function save() {
  if (saving.value || changedCount.value === 0 || anyInvalid.value) return;
  saving.value = true;
  saveError.value = null;
  const body: SetUserGroupRatesRequest = {};
  if (Object.keys(changes.value.rates).length) body.rates = changes.value.rates;
  if (Object.keys(changes.value.rpmOverrides).length) body.rpmOverrides = changes.value.rpmOverrides;
  try {
    const res = await apiJson<AdminUserGroupRatesResponse>(`/api/v1/admin/users/${encodeURIComponent(props.user.id)}/group-rates`, {
      method: "PUT",
      body,
    });
    fill(res.items);
    toast.success(t("userLimits.rates.saved"));
    emit("saved");
  } catch (err) {
    saveError.value = errorOf(err, t("userLimits.rates.saveFailed"));
  } finally {
    saving.value = false;
  }
}

/* ---------------- View ---------------- */

const customCount = computed(() => items.value.filter((g) => g.rateMultiplier !== null || g.rpmOverride !== null).length);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return items.value
    .filter((g) => !q || g.groupName.toLowerCase().includes(q) || g.platform.includes(q))
    .filter((g) => !onlyCustom.value || g.rateMultiplier !== null || g.rpmOverride !== null || isChanged(g))
    // Stable order (enabled first, then by name) so rows don't jump when a save changes them.
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.groupName.localeCompare(b.groupName));
});

function effectiveRate(g: AdminUserGroupRateItem): number {
  return draftRate(g.groupId) ?? g.groupRateMultiplier;
}
function rateTone(g: AdminUserGroupRateItem): string {
  const eff = effectiveRate(g);
  if (eff < g.groupRateMultiplier) return "text-success";
  if (eff > g.groupRateMultiplier) return "text-warning";
  return "text-fg-subtle";
}
function rpmEffective(g: AdminUserGroupRateItem): string {
  const o = draftRpm(g.groupId);
  if (o === null) return capText(g.groupRpmLimit, "rpm");
  if (o === 0) return t("userLimits.rates.exempt");
  return capText(o, "rpm");
}
const invalidClass = "!border-danger/60 focus:!ring-danger/20";
</script>

<template>
  <div class="space-y-4">
    <UiAlert tone="info">{{ t("userLimits.rates.intro") }}</UiAlert>

    <div class="flex flex-wrap items-center gap-2">
      <label class="relative min-w-[10rem] flex-1">
        <span class="sr-only">{{ t("common.search") }}</span>
        <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input v-model="search" type="search" class="input input-sm pl-8" :placeholder="t('userLimits.rates.search')" />
      </label>
      <UiSwitch v-model="onlyCustom" tone="accent" :label="t('userLimits.rates.onlyCustom', { n: customCount })" />
    </div>

    <UiAlert v-if="loadError && !loaded" tone="danger">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs" @click="load">{{ t("userLimits.common.retry") }}</button>
      </template>
    </UiAlert>

    <div v-else-if="!loaded" class="space-y-2" aria-busy="true">
      <div v-for="i in 4" :key="i" class="flex items-center gap-3 rounded-lg border border-line/60 p-3 motion-safe:animate-pulse">
        <span class="h-8 w-8 rounded-lg bg-surface-2" />
        <span class="flex-1 space-y-1.5">
          <span class="block h-2.5 w-32 rounded-full bg-surface-2" />
          <span class="block h-2 w-20 rounded-full bg-surface-2/70" />
        </span>
        <span class="h-8 w-24 rounded-md bg-surface-2" />
        <span class="hidden h-8 w-24 rounded-md bg-surface-2 sm:block" />
      </div>
    </div>

    <EmptyState v-else-if="items.length === 0" icon="layers" compact :title="t('userLimits.rates.noGroups')" />
    <EmptyState v-else-if="visible.length === 0" icon="search" compact :title="t('userLimits.rates.noMatch')" />

    <TransitionGroup
      v-else
      tag="ul"
      class="space-y-2"
      move-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="translate-y-1 opacity-0"
    >
      <li
        v-for="g in visible"
        :key="g.groupId"
        class="rounded-lg border px-3.5 py-3 transition-colors duration-200"
        :class="[isChanged(g) ? 'border-accent/40 bg-accent/[0.03]' : 'border-line/70 bg-surface dark:bg-surface-2/30', g.enabled ? '' : 'opacity-70']"
      >
        <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_8.5rem_8.5rem_2rem] md:items-start">
          <div class="flex min-w-0 items-start gap-2.5">
            <span class="icon-chip mt-0.5 h-8 w-8"><PlatformIcon :platform="g.platform" :size="15" /></span>
            <div class="min-w-0">
              <p class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-sm font-medium text-fg" :title="g.groupName">{{ g.groupName }}</span>
                <span v-if="g.isExclusive" class="shrink-0 text-violet" :title="t('userLimits.rates.exclusive')">
                  <UiIcon name="lock" :size="11" />
                  <span class="sr-only">{{ t("userLimits.rates.exclusive") }}</span>
                </span>
              </p>
              <p class="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-fg-subtle">
                <span>{{ t("userLimits.rates.listRate", { n: fmtRate(g.groupRateMultiplier) }) }}</span>
                <span>{{ t("userLimits.rates.groupRpm", { value: capText(g.groupRpmLimit, "rpm") }) }}</span>
                <span v-if="g.groupConcurrencyLimit > 0">{{ t("userLimits.rates.groupConc", { value: capText(g.groupConcurrencyLimit, "concurrency") }) }}</span>
                <span v-if="!g.enabled" class="text-warning">{{ t("common.disabled") }}</span>
              </p>
            </div>
          </div>

          <div class="min-w-0">
            <label :for="`gr-rate-${g.groupId}`" class="mb-1 block text-2xs text-fg-subtle md:sr-only">{{ t("userLimits.rates.customRate") }}</label>
            <div class="relative">
              <span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-xs text-fg-subtle">×</span>
              <input
                :id="`gr-rate-${g.groupId}`"
                v-model="rateText[g.groupId]"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                :placeholder="String(fmtRate(g.groupRateMultiplier))"
                :disabled="saving"
                class="input input-sm pl-6 font-mono"
                :class="rateInvalid(g.groupId) ? invalidClass : ''"
                :aria-invalid="rateInvalid(g.groupId) || undefined"
                :title="t('userLimits.rates.customRate')"
              />
            </div>
            <p class="mt-1 font-mono text-2xs tabular-nums" :class="rateInvalid(g.groupId) ? 'text-danger' : rateTone(g)">
              {{ rateInvalid(g.groupId) ? t("userLimits.rates.rateInvalid") : t("userLimits.rates.effective", { n: fmtRate(effectiveRate(g)) }) }}
            </p>
          </div>

          <div class="min-w-0">
            <label :for="`gr-rpm-${g.groupId}`" class="mb-1 block text-2xs text-fg-subtle md:sr-only">{{ t("userLimits.rates.rpmOverride") }}</label>
            <input
              :id="`gr-rpm-${g.groupId}`"
              v-model="rpmText[g.groupId]"
              type="number"
              inputmode="numeric"
              min="0"
              step="1"
              :placeholder="g.groupRpmLimit > 0 ? String(g.groupRpmLimit) : t('userLimits.rates.noCap')"
              :disabled="saving"
              class="input input-sm font-mono"
              :class="rpmInvalid(g.groupId) ? invalidClass : ''"
              :aria-invalid="rpmInvalid(g.groupId) || undefined"
              :title="t('userLimits.rates.rpmOverride')"
            />
            <p class="mt-1 text-2xs" :class="rpmInvalid(g.groupId) ? 'text-danger' : 'text-fg-subtle'">
              {{ rpmInvalid(g.groupId) ? t("userLimits.rates.rpmInvalid") : rpmEffective(g) }}
            </p>
          </div>

          <div class="flex justify-end md:pt-0.5">
            <button
              v-if="rateText[g.groupId] || rpmRaw(g.groupId)"
              type="button"
              class="btn btn-ghost btn-icon btn-xs"
              :disabled="saving"
              :title="t('userLimits.rates.clearRow')"
              :aria-label="t('userLimits.rates.clearRowFor', { name: g.groupName })"
              @click="clearRow(g)"
            >
              <UiIcon name="x" :size="13" />
            </button>
          </div>
        </div>
      </li>
    </TransitionGroup>

    <UiAlert v-if="saveError" tone="danger" class="animate-fade-in">{{ saveError }}</UiAlert>

    <div v-if="loaded && items.length" class="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-line/70 bg-surface/95 px-5 py-3 backdrop-blur">
      <span class="mr-auto text-xs" :class="changedCount ? 'text-warning' : 'text-fg-subtle'">
        {{ changedCount ? t("userLimits.rates.pending", { n: changedCount }) : t("userLimits.rates.legend") }}
      </span>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="!changedCount || saving" @click="discard">
        <UiIcon name="rotate-ccw" :size="13" />{{ t("userLimits.panel.discard") }}
      </button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="!changedCount || saving || anyInvalid" @click="save">
        <UiIcon :name="saving ? 'loader' : 'check'" :size="13" :spin="saving" />
        {{ saving ? t("common.saving") : t("userLimits.rates.save", { n: changedCount }) }}
      </button>
    </div>
  </div>
</template>
