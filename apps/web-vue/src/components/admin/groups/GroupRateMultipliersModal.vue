<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  AdminUserItem,
  AdminUserListResponse,
  GroupItem,
  GroupRateMultipliersResponse,
  SetGroupRateMultipliersRequest,
  SetGroupRpmOverridesRequest,
  UserStatus,
} from "@slipgate/contracts";
import { apiJson, toQuery } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiPagination from "../../ui/UiPagination.vue";
import UiTabs from "../../ui/UiTabs.vue";
import { displayName } from "../users/userDisplay";
import { fmtRate, parseLimit, parseRate, useLimitText } from "../users/limits";

/**
 * Per-user multipliers and RPM overrides of one group (Linksyncx GroupRateMultipliersModal and
 * its RPM twin). Each tab edits a local copy of its whole set; saving PUTs that set (users left
 * out lose their value in that tab only), so the batch factor and "clear all" stay local until saved.
 */
const props = defineProps<{ group: GroupItem | null }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "saved"): void }>();

const { t, capText, errorOf } = useLimitText();
const toast = useToastStore();

type Tab = "rates" | "rpm";
interface Row {
  userId: string;
  email: string;
  username: string;
  status: UserStatus;
  /** Typed value ("" = invalid / not set yet). */
  text: string;
}

const tab = ref<Tab>("rates");
const server = ref<GroupRateMultipliersResponse | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const rates = ref<Row[]>([]);
const rpms = ref<Row[]>([]);

function fromServer(res: GroupRateMultipliersResponse) {
  server.value = res;
  rates.value = res.items
    .filter((e) => e.rateMultiplier !== null)
    .map((e) => ({ userId: e.userId, email: e.email, username: e.username, status: e.status, text: String(e.rateMultiplier) }));
  rpms.value = res.items
    .filter((e) => e.rpmOverride !== null)
    .map((e) => ({ userId: e.userId, email: e.email, username: e.username, status: e.status, text: String(e.rpmOverride) }));
}

let seq = 0;
async function load() {
  const g = props.group;
  if (!g) return;
  const id = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await apiJson<GroupRateMultipliersResponse>(`/api/v1/admin/groups/${encodeURIComponent(g.id)}/rate-multipliers`);
    if (id === seq) fromServer(res);
  } catch (err) {
    if (id === seq) loadError.value = errorOf(err, t("userLimits.groupRates.loadFailed"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  tab.value = "rates";
  server.value = null;
  rates.value = [];
  rpms.value = [];
  saveError.value = null;
  resetAdder();
  factor.value = "";
  filter.value = "";
  page.value = 1;
  void load();
});

/* ---------------- Values & dirty state ---------------- */

const parseOf = (which: Tab, text: string) => (which === "rates" ? parseRate(text) : parseLimit(text));
const rowsOf = (which: Tab) => (which === "rates" ? rates : rpms);
const invalid = (which: Tab, r: Row) => parseOf(which, r.text) === null;

function serverMap(which: Tab): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of server.value?.items ?? []) {
    const v = which === "rates" ? e.rateMultiplier : e.rpmOverride;
    if (v !== null) m.set(e.userId, v);
  }
  return m;
}

function dirtyOf(which: Tab): boolean {
  const base = serverMap(which);
  const rows = rowsOf(which).value;
  if (rows.length !== base.size) return true;
  return rows.some((r) => base.get(r.userId) !== parseOf(which, r.text));
}
const dirty = computed(() => ({ rates: dirtyOf("rates"), rpm: dirtyOf("rpm") }));
const anyInvalid = computed(() => rowsOf(tab.value).value.some((r) => invalid(tab.value, r)));

const tabs = computed(() => [
  { key: "rates" as const, label: t("userLimits.groupRates.tabs.rates") + (dirty.value.rates ? " •" : ""), icon: "percent" as const, count: rates.value.length },
  { key: "rpm" as const, label: t("userLimits.groupRates.tabs.rpm") + (dirty.value.rpm ? " •" : ""), icon: "gauge" as const, count: rpms.value.length },
]);

/* ---------------- Filter & paging ---------------- */

const filter = ref("");
const page = ref(1);
const pageSize = ref(10);
watch([tab, filter, pageSize], () => (page.value = 1));

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const rows = rowsOf(tab.value).value;
  return q ? rows.filter((r) => r.email.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)) : rows;
});
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch(filtered, (rows) => {
  const last = Math.max(1, Math.ceil(rows.length / pageSize.value));
  if (page.value > last) page.value = last;
});

/* ---------------- Adding users ---------------- */

const query = ref("");
const results = ref<AdminUserItem[]>([]);
const searching = ref(false);
const listOpen = ref(false);
const active = ref(-1);
const picked = ref<AdminUserItem | null>(null);
const newValue = ref("");
let searchTimer: number | undefined;
let searchSeq = 0;

function resetAdder() {
  query.value = "";
  results.value = [];
  listOpen.value = false;
  active.value = -1;
  picked.value = null;
  newValue.value = "";
}

watch(query, (q) => {
  window.clearTimeout(searchTimer);
  if (picked.value && q !== picked.value.email) picked.value = null;
  const needle = q.trim();
  if (!needle || picked.value) {
    results.value = [];
    listOpen.value = false;
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const id = ++searchSeq;
    searching.value = true;
    try {
      const res = await apiJson<AdminUserListResponse>(`/api/v1/admin/users${toQuery({ search: needle, pageSize: 8 })}`);
      if (id !== searchSeq) return;
      results.value = res.items;
      listOpen.value = true;
      active.value = res.items.length ? 0 : -1;
    } catch {
      if (id === searchSeq) results.value = [];
    } finally {
      if (id === searchSeq) searching.value = false;
    }
  }, 250);
});
onBeforeUnmount(() => window.clearTimeout(searchTimer));

function pick(u: AdminUserItem) {
  picked.value = u;
  query.value = u.email;
  listOpen.value = false;
  results.value = [];
  if (!newValue.value) {
    const existing = rowsOf(tab.value).value.find((r) => r.userId === u.id);
    if (existing) newValue.value = existing.text;
  }
}

function onSearchKey(ev: KeyboardEvent) {
  if (!listOpen.value || results.value.length === 0) return;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    active.value = (active.value + 1) % results.value.length;
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    active.value = (active.value - 1 + results.value.length) % results.value.length;
  } else if (ev.key === "Enter" && active.value >= 0) {
    ev.preventDefault();
    pick(results.value[active.value]!);
  } else if (ev.key === "Escape") {
    ev.stopPropagation();
    listOpen.value = false;
  }
}

const newValueValid = computed(() => parseOf(tab.value, newValue.value) !== null);
const canAdd = computed(() => Boolean(picked.value) && newValueValid.value);

function add() {
  const u = picked.value;
  if (!u || !newValueValid.value) return;
  const rows = rowsOf(tab.value);
  const row: Row = { userId: u.id, email: u.email, username: u.username, status: u.status, text: newValue.value.trim() };
  const i = rows.value.findIndex((r) => r.userId === u.id);
  if (i >= 0) rows.value = rows.value.map((r, j) => (j === i ? row : r));
  else rows.value = [row, ...rows.value];
  resetAdder();
  filter.value = "";
  page.value = 1;
}

function remove(userId: string) {
  const rows = rowsOf(tab.value);
  rows.value = rows.value.filter((r) => r.userId !== userId);
}

function clearAll() {
  rowsOf(tab.value).value = [];
}

/** Back to the saved set, for the current tab only. */
function discard() {
  const res = server.value;
  if (!res) return;
  const other = tab.value === "rates" ? rpms.value : rates.value;
  fromServer(res);
  if (tab.value === "rates") rpms.value = other;
  else rates.value = other;
  saveError.value = null;
}

/* ---------------- Batch factor (rates tab) ---------------- */

const factor = ref("");
const factorValue = computed(() => {
  const raw = factor.value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n !== 1 ? n : null;
});
const factorPreview = (r: Row) => {
  const base = parseRate(r.text);
  return base === null || factorValue.value === null ? null : fmtRate(base * factorValue.value);
};
const factorOverflow = computed(
  () => factorValue.value !== null && rates.value.some((r) => (parseRate(r.text) ?? 0) * factorValue.value! > 100),
);
function applyFactor() {
  const f = factorValue.value;
  if (f === null || factorOverflow.value) return;
  rates.value = rates.value.map((r) => {
    const base = parseRate(r.text);
    return base === null ? r : { ...r, text: String(Number((base * f).toFixed(6))) };
  });
  factor.value = "";
}

/* ---------------- Save ---------------- */

async function save() {
  const g = props.group;
  if (!g || saving.value || anyInvalid.value || !dirty.value[tab.value]) return;
  saving.value = true;
  saveError.value = null;
  try {
    if (tab.value === "rates") {
      const body: SetGroupRateMultipliersRequest = {
        entries: rates.value.map((r) => ({ userId: r.userId, rateMultiplier: parseRate(r.text)! })),
      };
      await apiJson(`/api/v1/admin/groups/${encodeURIComponent(g.id)}/rate-multipliers`, { method: "PUT", body });
      toast.success(t("userLimits.groupRates.ratesSaved", { n: body.entries.length }));
    } else {
      const body: SetGroupRpmOverridesRequest = {
        entries: rpms.value.map((r) => ({ userId: r.userId, rpmOverride: parseLimit(r.text) })),
      };
      await apiJson(`/api/v1/admin/groups/${encodeURIComponent(g.id)}/rpm-overrides`, { method: "PUT", body });
      toast.success(t("userLimits.groupRates.rpmSaved", { n: body.entries.length }));
    }
    // Keep the other tab's unsaved edits across the reload.
    const keep = tab.value === "rates" ? { which: "rpm" as const, rows: rpms.value, was: dirty.value.rpm } : { which: "rates" as const, rows: rates.value, was: dirty.value.rates };
    const res = await apiJson<GroupRateMultipliersResponse>(`/api/v1/admin/groups/${encodeURIComponent(g.id)}/rate-multipliers`);
    fromServer(res);
    if (keep.was) rowsOf(keep.which).value = keep.rows;
    emit("saved");
  } catch (err) {
    saveError.value = errorOf(err, t("userLimits.groupRates.saveFailed"));
  } finally {
    saving.value = false;
  }
}

function effective(r: Row): string {
  if (tab.value === "rates") {
    const v = parseRate(r.text);
    return v === null ? "—" : `×${fmtRate(v)}`;
  }
  const v = parseLimit(r.text);
  if (v === null) return "—";
  return v === 0 ? t("userLimits.rates.exempt") : capText(v, "rpm");
}
function rateTone(r: Row): string {
  const v = parseRate(r.text);
  const base = server.value?.groupRateMultiplier ?? 1;
  if (v === null) return "text-danger";
  return v < base ? "text-success" : v > base ? "text-warning" : "text-fg-subtle";
}
const invalidClass = "!border-danger/60 focus:!ring-danger/20";
</script>

<template>
  <UiModal v-model:open="open" width="xl" :persistent="saving" :title="t('userLimits.groupRates.title', { name: group?.name ?? '' })">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="percent" :size="15" /></span>
    </template>

    <div v-if="group" class="space-y-4">
      <!-- Group summary -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line/70 bg-surface-2/40 px-3.5 py-2.5 text-xs">
        <span class="flex items-center gap-1.5 font-medium text-fg"><PlatformIcon :platform="group.platform" :size="13" />{{ group.name }}</span>
        <span class="text-fg-subtle">{{ t("userLimits.groupRates.listRate") }} <b class="font-mono text-fg">×{{ fmtRate(group.rateMultiplier) }}</b></span>
        <span class="text-fg-subtle">{{ t("userLimits.groupRates.groupRpm") }} <b class="font-mono text-fg">{{ capText(group.rpmLimit, "rpm") }}</b></span>
        <span class="text-fg-subtle">{{ t("userLimits.groupRates.groupConc") }} <b class="font-mono text-fg">{{ capText(group.concurrencyLimit, "concurrency") }}</b></span>
      </div>

      <UiTabs v-model="tab" :tabs="tabs" />

      <p class="text-xs text-fg-subtle">{{ tab === "rates" ? t("userLimits.groupRates.ratesIntro") : t("userLimits.groupRates.rpmIntro") }}</p>

      <!-- Add / update a user -->
      <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
        <div class="relative min-w-0">
          <label for="grm-search" class="sr-only">{{ t("userLimits.groupRates.searchUser") }}</label>
          <UiIcon
            :name="searching ? 'loader' : 'search'"
            :spin="searching"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            id="grm-search"
            v-model="query"
            type="search"
            autocomplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="grm-results"
            :aria-expanded="listOpen"
            :aria-activedescendant="listOpen && active >= 0 ? `grm-opt-${active}` : undefined"
            class="input input-sm pl-8"
            :placeholder="t('userLimits.groupRates.searchUser')"
            @keydown="onSearchKey"
            @blur="listOpen = false"
          />
          <Transition
            enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
            leave-to-class="opacity-0"
          >
            <ul
              v-if="listOpen"
              id="grm-results"
              role="listbox"
              class="menu-panel absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto"
            >
              <li v-if="results.length === 0" class="px-2.5 py-2 text-xs text-fg-subtle">{{ t("userLimits.groupRates.noUsers") }}</li>
              <li
                v-for="(u, i) in results"
                :id="`grm-opt-${i}`"
                :key="u.id"
                role="option"
                :aria-selected="i === active"
                class="menu-item py-1.5"
                :class="i === active ? 'bg-surface-2 text-fg' : ''"
                @mousedown.prevent="pick(u)"
                @mouseenter="active = i"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ u.email }}</span>
                  <span class="block truncate text-2xs text-fg-subtle">{{ displayName(u) }}</span>
                </span>
                <span v-if="rowsOf(tab).value.some((r) => r.userId === u.id)" class="shrink-0 text-2xs text-accent">{{ t("userLimits.groupRates.listed") }}</span>
              </li>
            </ul>
          </Transition>
        </div>
        <label class="relative min-w-0">
          <span class="sr-only">{{ tab === "rates" ? t("userLimits.groupRates.rate") : t("userLimits.groupRates.rpm") }}</span>
          <span v-if="tab === 'rates'" class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-xs text-fg-subtle">×</span>
          <input
            v-model="newValue"
            type="text"
            :inputmode="tab === 'rates' ? 'decimal' : 'numeric'"
            autocomplete="off"
            class="input input-sm font-mono"
            :class="[tab === 'rates' ? 'pl-6' : '', newValue && !newValueValid ? invalidClass : '']"
            :placeholder="tab === 'rates' ? String(fmtRate(group.rateMultiplier)) : t('userLimits.groupRates.rpmPlaceholder')"
            @keydown.enter.prevent="add"
          />
        </label>
        <button type="button" class="btn btn-primary btn-sm" :disabled="!canAdd" @click="add">
          <UiIcon name="plus" :size="13" />{{ t("userLimits.groupRates.add") }}
        </button>
      </div>
      <p v-if="newValue && !newValueValid" class="-mt-2 text-xs text-danger">
        {{ tab === "rates" ? t("userLimits.rates.rateInvalid") : t("userLimits.rates.rpmInvalid") }}
      </p>

      <!-- Toolbar -->
      <div class="flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
        <label class="relative min-w-[9rem] flex-1 sm:max-w-[14rem]">
          <span class="sr-only">{{ t("userLimits.groupRates.filter") }}</span>
          <UiIcon name="filter" :size="13" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input v-model="filter" type="search" class="input input-sm pl-8" :placeholder="t('userLimits.groupRates.filter')" />
        </label>
        <template v-if="tab === 'rates'">
          <label class="relative w-24">
            <span class="sr-only">{{ t("userLimits.groupRates.factor") }}</span>
            <span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-xs text-fg-subtle">×</span>
            <input
              v-model="factor"
              type="text"
              inputmode="decimal"
              class="input input-sm pl-6 font-mono"
              :class="factorOverflow ? invalidClass : ''"
              :placeholder="t('userLimits.groupRates.factorPlaceholder')"
              :title="t('userLimits.groupRates.factorHint')"
            />
          </label>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="factorValue === null || factorOverflow || rates.length === 0"
            :title="factorOverflow ? t('userLimits.groupRates.factorOverflow') : t('userLimits.groupRates.factorHint')"
            @click="applyFactor"
          >
            <UiIcon name="sparkles" :size="13" />{{ t("userLimits.groupRates.applyFactor") }}
          </button>
        </template>
        <ConfirmButton
          class="ml-auto"
          size="sm"
          :label="t('userLimits.groupRates.clearAll')"
          :confirm-label="t('userLimits.groupRates.clearConfirm')"
          :disabled="rowsOf(tab).value.length === 0 || saving"
          @confirm="clearAll"
        />
      </div>

      <!-- List -->
      <UiAlert v-if="loadError && !server" tone="danger">
        {{ loadError }}
        <template #action>
          <button type="button" class="btn btn-secondary btn-xs" @click="load">{{ t("userLimits.common.retry") }}</button>
        </template>
      </UiAlert>
      <div v-else-if="!server" class="space-y-2" aria-busy="true">
        <div v-for="i in 4" :key="i" class="flex items-center gap-3 rounded-lg border border-line/60 px-3.5 py-2.5 motion-safe:animate-pulse">
          <span class="flex-1 space-y-1.5">
            <span class="block h-2.5 w-40 max-w-full rounded-full bg-surface-2" />
            <span class="block h-2 w-24 rounded-full bg-surface-2/70" />
          </span>
          <span class="h-7 w-24 rounded-md bg-surface-2" />
        </div>
      </div>
      <EmptyState
        v-else-if="rowsOf(tab).value.length === 0"
        :icon="tab === 'rates' ? 'percent' : 'gauge'"
        compact
        :title="tab === 'rates' ? t('userLimits.groupRates.emptyRates') : t('userLimits.groupRates.emptyRpm')"
      />
      <EmptyState v-else-if="filtered.length === 0" icon="search" compact :title="t('userLimits.groupRates.noMatch')" />
      <div v-else class="overflow-hidden rounded-lg border border-line/70">
        <TransitionGroup
          tag="ul"
          class="divide-y divide-line/60"
          move-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="opacity-0"
        >
          <li v-for="r in paged" :key="`${tab}-${r.userId}`" class="grid gap-2 px-3.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_8rem_6rem_2rem] sm:items-center">
            <div class="min-w-0">
              <p class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-sm text-fg" :title="r.email">{{ r.email }}</span>
                <span v-if="r.status === 'suspended'" class="shrink-0 rounded-full bg-danger/10 px-1.5 text-2xs text-danger">
                  {{ t("adminUsers.statuses.suspended") }}
                </span>
              </p>
              <p v-if="r.username" class="truncate text-2xs text-fg-subtle">{{ r.username }}</p>
            </div>
            <label class="relative min-w-0">
              <span class="sr-only">{{ t("userLimits.groupRates.valueFor", { email: r.email }) }}</span>
              <span v-if="tab === 'rates'" class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-xs text-fg-subtle">×</span>
              <input
                v-model="r.text"
                type="text"
                :inputmode="tab === 'rates' ? 'decimal' : 'numeric'"
                autocomplete="off"
                :disabled="saving"
                class="input input-sm font-mono"
                :class="[tab === 'rates' ? 'pl-6' : '', invalid(tab, r) ? invalidClass : '']"
                :aria-invalid="invalid(tab, r) || undefined"
              />
            </label>
            <span class="font-mono text-2xs tabular-nums sm:text-right" :class="tab === 'rates' ? rateTone(r) : 'text-fg-subtle'">
              <template v-if="tab === 'rates' && factorPreview(r) !== null">→ ×{{ factorPreview(r) }}</template>
              <template v-else>{{ effective(r) }}</template>
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs justify-self-end hover:!bg-danger/10 hover:!text-danger"
              :disabled="saving"
              :title="t('userLimits.groupRates.remove')"
              :aria-label="t('userLimits.groupRates.removeFor', { email: r.email })"
              @click="remove(r.userId)"
            >
              <UiIcon name="x" :size="13" />
            </button>
          </li>
        </TransitionGroup>
        <UiPagination
          v-if="filtered.length > 10"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="filtered.length"
          :page-sizes="[10, 20, 50]"
          :disabled="saving"
        />
      </div>

      <UiAlert v-if="saveError" tone="danger" class="animate-fade-in">{{ saveError }}</UiAlert>
    </div>

    <template #footer>
      <span v-if="dirty.rates || dirty.rpm" class="mr-auto inline-flex items-center gap-1.5 text-xs text-warning">
        <span class="h-1.5 w-1.5 rounded-full bg-warning" />{{ t("userLimits.groupRates.unsaved") }}
      </span>
      <button type="button" class="btn btn-ghost" :disabled="saving || !dirty[tab]" @click="discard">
        {{ t("userLimits.panel.discard") }}
      </button>
      <button type="button" class="btn btn-primary" :disabled="saving || !dirty[tab] || anyInvalid || !server" @click="save">
        <UiIcon :name="saving ? 'loader' : 'check'" :size="15" :spin="saving" />
        {{ saving ? t("common.saving") : tab === "rates" ? t("userLimits.groupRates.saveRates") : t("userLimits.groupRates.saveRpm") }}
      </button>
    </template>
  </UiModal>
</template>
