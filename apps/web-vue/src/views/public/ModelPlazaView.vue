<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ModelPlazaResponse, ModelPrice, PlazaGroup } from "@slipgate/contracts";
import PublicLayout from "../../components/PublicLayout.vue";
import PlazaGroupCard from "../../components/public/PlazaGroupCard.vue";
import PublicDisabled from "../../components/public/PublicDisabled.vue";
import PublicHero from "../../components/public/PublicHero.vue";
import { formatPerMillion, providerLabel, providerRank, usdPerMillion, useCopyText } from "../../components/public/publicUtils";
import { vReveal } from "../../components/public/reveal";
import EmptyState from "../../components/ui/EmptyState.vue";
import PlatformIcon from "../../components/ui/PlatformIcon.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { ApiError, apiJson, errorText, publicJson } from "../../lib/api";
import { platformStyle } from "../../lib/platformStyle";
import { useAuthStore } from "../../stores/auth";
import { useUserGroupRates } from "../../composables/useUserGroupRates";

const { t } = useI18n();
const auth = useAuthStore();
const { copied, copy } = useCopyText();
/** Signed-in viewers see prices at their own per-group multiplier (lane U1). */
const userRates = useUserGroupRates();

const data = ref<ModelPlazaResponse | null>(null);
const loading = ref(true);
const disabled = ref(false);
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    // Signed-in viewers also see the exclusive groups they were granted.
    if (auth.isAuthenticated) {
      // Rates are a refinement: the plaza still renders at list prices if they fail.
      const [models] = await Promise.all([apiJson<ModelPlazaResponse>("/api/v1/user/models"), userRates.load(t("userLimits.mine.loadFailed"))]);
      data.value = models;
    } else {
      data.value = await publicJson<ModelPlazaResponse>("/api/v1/public/models");
    }
    disabled.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) disabled.value = true;
    else error.value = errorText(err, t("public.common.loadFailed"));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/* ---------------- Filters ---------------- */
const view = ref<"groups" | "models">("groups");
const query = ref("");
const provider = ref("all");
const needle = computed(() => query.value.trim().toLowerCase());
const groups = computed(() => userRates.withEffectiveRates(data.value?.groups ?? []));
/** The list multiplier of a group where the viewer has a custom one, else null. */
function listRateOf(groupId: string): number | null {
  const r = userRates.byGroup.value.get(groupId);
  return r && r.customRateMultiplier !== null ? r.groupRateMultiplier : null;
}

const providers = computed(() => {
  const set = new Set<string>();
  for (const g of groups.value) for (const m of g.models) set.add(m.provider);
  return [...set].sort((a, b) => providerRank(a) - providerRank(b) || a.localeCompare(b));
});

const filteredGroups = computed<PlazaGroup[]>(() => {
  const out: PlazaGroup[] = [];
  for (const g of groups.value) {
    const groupHit = !needle.value || g.name.toLowerCase().includes(needle.value) || g.description.toLowerCase().includes(needle.value);
    const models = g.models.filter(
      (m) => (provider.value === "all" || m.provider === provider.value) && (groupHit || m.id.toLowerCase().includes(needle.value)),
    );
    if (models.length || (groupHit && provider.value === "all")) out.push({ ...g, models });
  }
  return out;
});

interface Offer {
  groupId: string;
  name: string;
  multiplier: number;
}
interface ModelRow {
  id: string;
  provider: string;
  price: ModelPrice;
  offers: Offer[];
}

const modelRows = computed<ModelRow[]>(() => {
  const map = new Map<string, ModelRow>();
  for (const g of groups.value) {
    for (const m of g.models) {
      let row = map.get(m.id);
      if (!row) {
        row = { id: m.id, provider: m.provider, price: m.price, offers: [] };
        map.set(m.id, row);
      }
      row.offers.push({ groupId: g.id, name: g.name, multiplier: g.rateMultiplier });
    }
  }
  const rows = [...map.values()];
  for (const r of rows) r.offers.sort((a, b) => a.multiplier - b.multiplier || a.name.localeCompare(b.name));
  return rows.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
});

const filteredModels = computed(() =>
  modelRows.value.filter(
    (r) =>
      (provider.value === "all" || r.provider === provider.value) &&
      (!needle.value || r.id.toLowerCase().includes(needle.value) || r.offers.some((o) => o.name.toLowerCase().includes(needle.value))),
  ),
);

const hasFilters = computed(() => Boolean(needle.value) || provider.value !== "all");
function clearFilters() {
  query.value = "";
  provider.value = "all";
}

const viewOptions = computed(() => [
  { value: "groups" as const, label: t("public.plaza.viewGroups"), count: filteredGroups.value.length },
  { value: "models" as const, label: t("public.plaza.viewModels"), count: filteredModels.value.length },
]);

const price = (nano: number, multiplier = 1) => formatPerMillion(usdPerMillion(nano, multiplier));
const fmtMultiplier = (m: number) => Number(m.toFixed(3));
const multiplierClass = (m: number) => (m < 1 ? "bg-success/10 text-success" : m > 1 ? "bg-warning/10 text-warning" : "bg-surface-2 text-fg-muted");
</script>

<template>
  <PublicLayout>
    <PublicDisabled v-if="disabled" />
    <template v-else>
      <PublicHero icon="store" :eyebrow="t('public.plaza.eyebrow')" :title="t('public.plaza.title')" :subtitle="t('public.plaza.subtitle')">
        <div v-if="data" class="mt-5 flex flex-wrap gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line">
            <UiIcon name="layers" :size="13" class="text-accent" />
            {{ t("public.plaza.groupsCount", { n: groups.length }) }}
          </span>
          <span class="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line">
            <UiIcon name="sparkles" :size="13" class="text-accent" />
            {{ t("public.plaza.modelsCount", { n: modelRows.length }) }}
          </span>
        </div>
      </PublicHero>

      <div class="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <!-- Toolbar -->
        <div class="card glass z-20 space-y-3 p-3 sm:sticky sm:top-20 sm:p-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SegmentedControl v-model="view" :options="viewOptions" size="md" />
            <label class="relative block min-w-0 flex-1">
              <span class="sr-only">{{ t("public.plaza.search") }}</span>
              <UiIcon name="search" :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input v-model="query" type="search" class="input pl-9" :placeholder="t('public.plaza.search')" autocomplete="off" />
            </label>
          </div>
          <div v-if="providers.length > 1" class="scrollbar-hide -mx-1 flex gap-1.5 overflow-x-auto px-1" role="radiogroup">
            <button
              type="button"
              role="radio"
              :aria-checked="provider === 'all'"
              class="provider-chip"
              :class="provider === 'all' ? 'provider-chip-on' : ''"
              @click="provider = 'all'"
            >
              {{ t("public.common.allPlatforms") }}
            </button>
            <button
              v-for="p in providers"
              :key="p"
              type="button"
              role="radio"
              :aria-checked="provider === p"
              class="provider-chip"
              :class="provider === p ? 'provider-chip-on' : ''"
              @click="provider = p"
            >
              <PlatformIcon :platform="p" :size="13" />
              {{ providerLabel(p) }}
            </button>
          </div>
        </div>

        <p class="sr-only" aria-live="polite">{{ copied ? `${t("public.plaza.copied")}: ${copied}` : "" }}</p>

        <UiAlert v-if="error" tone="danger" class="mt-6">
          {{ error }}
          <template #action>
            <button type="button" class="btn btn-secondary btn-sm" @click="load">
              <UiIcon name="refresh" :size="13" />
              {{ t("public.common.retry") }}
            </button>
          </template>
        </UiAlert>

        <!-- Loading -->
        <div v-if="loading && !data" class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          <div v-for="i in 6" :key="i" class="card animate-pulse p-5">
            <div class="flex items-center gap-3">
              <div class="h-10 w-10 rounded-xl bg-surface-2" />
              <div class="flex-1 space-y-2">
                <div class="h-3 w-1/2 rounded bg-surface-2" />
                <div class="h-2.5 w-1/4 rounded bg-surface-2" />
              </div>
            </div>
            <div class="mt-4 h-2.5 w-5/6 rounded bg-surface-2" />
            <div class="mt-2 h-2.5 w-2/3 rounded bg-surface-2" />
            <div class="mt-5 flex flex-wrap gap-1.5">
              <div v-for="j in 5" :key="j" class="h-6 w-24 rounded-md bg-surface-2" />
            </div>
          </div>
        </div>

        <template v-else-if="data">
          <div v-if="!groups.length" class="card mt-6">
            <EmptyState icon="store" :title="t('public.plaza.empty')" />
          </div>

          <div
            v-else-if="(view === 'groups' && !filteredGroups.length) || (view === 'models' && !filteredModels.length)"
            class="card mt-6"
          >
            <EmptyState icon="search" :title="t('public.plaza.noMatch')">
              <button v-if="hasFilters" type="button" class="btn btn-secondary btn-sm" @click="clearFilters">
                <UiIcon name="x" :size="13" />
                {{ t("public.plaza.clearFilters") }}
              </button>
            </EmptyState>
          </div>

          <!-- By group -->
          <div v-else-if="view === 'groups'" class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div v-for="(g, i) in filteredGroups" :key="g.id" v-reveal="(i % 3) * 70" class="min-w-0">
              <PlazaGroupCard :group="g" :copied="copied" :list-rate="listRateOf(g.id)" @copy="copy" />
            </div>
          </div>

          <!-- By model -->
          <div v-else class="card mt-6 overflow-hidden animate-fade-in">
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>{{ t("public.plaza.col.model") }}</th>
                    <th class="text-right">{{ t("public.plaza.col.input") }}</th>
                    <th class="text-right">{{ t("public.plaza.col.output") }}</th>
                    <th class="text-right">{{ t("public.plaza.col.cacheRead") }}</th>
                    <th class="text-right">{{ t("public.plaza.col.cacheWrite") }}</th>
                    <th>{{ t("public.plaza.col.groups") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in filteredModels" :key="r.id">
                    <td class="min-w-[14rem]">
                      <button
                        type="button"
                        class="group/model flex cursor-pointer items-center gap-2.5 rounded-lg text-left"
                        :title="t('public.plaza.copyHint')"
                        @click="copy(r.id)"
                      >
                        <span class="icon-chip h-8 w-8" :class="platformStyle(r.provider).badge">
                          <PlatformIcon :platform="r.provider" :size="15" />
                        </span>
                        <span class="min-w-0">
                          <span
                            class="flex items-center gap-1.5 font-mono text-xs font-medium transition-colors"
                            :class="copied === r.id ? 'text-success' : 'text-fg group-hover/model:text-accent'"
                          >
                            {{ r.id }}
                            <UiIcon
                              :name="copied === r.id ? 'check' : 'copy'"
                              :size="12"
                              class="transition-opacity"
                              :class="copied === r.id ? 'opacity-100' : 'opacity-0 group-hover/model:opacity-70 group-focus-visible/model:opacity-70'"
                            />
                          </span>
                          <span class="mt-0.5 block text-2xs text-fg-subtle">{{ providerLabel(r.provider) }}</span>
                        </span>
                      </button>
                    </td>
                    <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">{{ price(r.price.inputNanoPerToken) }}</td>
                    <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">{{ price(r.price.outputNanoPerToken) }}</td>
                    <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">{{ price(r.price.cacheReadNanoPerToken) }}</td>
                    <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">{{ price(r.price.cacheWriteNanoPerToken) }}</td>
                    <td>
                      <ul class="space-y-1">
                        <li v-for="o in r.offers" :key="o.groupId" class="flex items-center gap-2 whitespace-nowrap text-xs">
                          <span class="max-w-[10rem] truncate text-fg" :title="o.name">{{ o.name }}</span>
                          <span class="rounded px-1 font-mono text-2xs" :class="multiplierClass(o.multiplier)">×{{ fmtMultiplier(o.multiplier) }}</span>
                          <span class="font-mono text-2xs tabular-nums text-fg-muted">
                            {{ price(r.price.inputNanoPerToken, o.multiplier) }} / {{ price(r.price.outputNanoPerToken, o.multiplier) }}
                          </span>
                        </li>
                      </ul>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="flex items-start gap-2 border-t border-line/70 bg-surface-2/40 px-5 py-3 text-2xs text-fg-subtle">
              <UiIcon name="info" :size="13" class="mt-px" />
              {{ t("public.plaza.priceNote") }}
            </p>
          </div>

          <p v-if="view === 'groups' && filteredGroups.length" class="mt-6 flex items-center justify-center gap-1.5 text-2xs text-fg-subtle">
            <UiIcon name="info" :size="12" />
            {{ t("public.plaza.multiplierHint") }} · {{ t("public.common.perMillion") }}
          </p>
        </template>
      </div>
    </template>
  </PublicLayout>
</template>

<style scoped>
.provider-chip {
  @apply inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-line/80 bg-surface px-3 text-xs font-medium text-fg-muted transition-colors duration-150 hover:border-line-strong hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40;
}
.provider-chip-on {
  @apply border-accent/30 bg-accent/10 text-accent hover:border-accent/40 hover:text-accent;
}
</style>
