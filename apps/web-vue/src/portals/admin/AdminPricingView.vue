<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { GroupItem, ModelPricingRule } from "@slipgate/contracts";
import BuiltinRatesCard from "../../components/admin/pricing/BuiltinRatesCard.vue";
import PriceTesterCard from "../../components/admin/pricing/PriceTesterCard.vue";
import PricingExplainer from "../../components/admin/pricing/PricingExplainer.vue";
import PricingRuleModal from "../../components/admin/pricing/PricingRuleModal.vue";
import PricingRulesCard from "../../components/admin/pricing/PricingRulesCard.vue";
import {
  presetFromPrices,
  ruleToBody,
  sortRules,
  type BuiltinTier,
  type RulePreset,
} from "../../components/admin/pricing/pricingUtil";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { apiJson, errorText } from "../../lib/api";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toast = useToastStore();

const rules = ref<ModelPricingRule[]>([]);
const groups = ref<GroupItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const busyIds = ref(new Set<string>());
const testerMatchId = ref<string | null>(null);
const syncingPresets = ref(false);

const enabledCount = computed(() => rules.value.filter((r) => r.enabled).length);

function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

function upsertLocal(item: ModelPricingRule) {
  const rest = rules.value.filter((r) => r.id !== item.id);
  rules.value = sortRules([...rest, item]);
}

/* ---------------- Loading ---------------- */

async function load() {
  loading.value = true;
  try {
    const res = await apiJson<{ items: ModelPricingRule[] }>("/api/v1/admin/pricing", {
      fallbackError: t("pricing.errors.load"),
    });
    rules.value = sortRules(res.items);
    loaded.value = true;
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("pricing.errors.load"));
    if (loaded.value) toast.error(loadError.value);
  } finally {
    loading.value = false;
  }
}

/** Groups only feed the multiplier pickers; the page works without them. */
async function loadGroups() {
  try {
    const res = await apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups");
    groups.value = res.groups;
  } catch {
    groups.value = [];
  }
}

function refresh() {
  void load();
  void loadGroups();
}

/* ---------------- Create / edit ---------------- */

const modalOpen = ref(false);
const editing = ref<ModelPricingRule | null>(null);
const preset = ref<RulePreset | null>(null);

function openCreate(initial: RulePreset | null = null) {
  editing.value = null;
  preset.value = initial;
  modalOpen.value = true;
}

function openEdit(rule: ModelPricingRule) {
  editing.value = rule;
  preset.value = null;
  modalOpen.value = true;
}

/** Built-in tier → edit the existing rule for its pattern, or start one with its rates. */
function overrideTier(tier: BuiltinTier) {
  if (!tier.suggestPattern) return;
  const existing = rules.value.find((r) => r.pattern === tier.suggestPattern);
  if (existing) openEdit(existing);
  else openCreate(presetFromPrices(tier.suggestPattern, tier.prices));
}

function onSaved(item: ModelPricingRule, created: boolean) {
  upsertLocal(item);
  toast.success(created ? t("pricing.notice.created", { pattern: item.pattern }) : t("pricing.notice.saved", { pattern: item.pattern }));
}

async function syncPresets() {
  if (syncingPresets.value) return;
  syncingPresets.value = true;
  try {
    const res = await apiJson<{ added: number; updated: number; total: number; items: ModelPricingRule[] }>(
      "/api/v1/admin/pricing/sync-presets",
      {
        method: "POST",
        body: { overwrite: false },
        fallbackError: t("pricing.errors.syncPresets"),
      },
    );
    rules.value = sortRules(res.items);
    loaded.value = true;
    toast.success(t("pricing.notice.presetsSynced", { added: res.added, total: res.total }));
  } catch (err) {
    toast.error(errorText(err, t("pricing.errors.syncPresets")));
  } finally {
    syncingPresets.value = false;
  }
}

/* ---------------- Row actions ---------------- */

async function toggle(rule: ModelPricingRule) {
  setBusy(rule.id, true);
  try {
    const { item } = await apiJson<{ item: ModelPricingRule }>(`/api/v1/admin/pricing/${encodeURIComponent(rule.id)}`, {
      method: "PUT",
      body: ruleToBody(rule, { enabled: !rule.enabled }),
      fallbackError: t("pricing.errors.toggle"),
    });
    upsertLocal(item);
    toast.success(
      item.enabled ? t("pricing.notice.enabled", { pattern: item.pattern }) : t("pricing.notice.disabled", { pattern: item.pattern }),
    );
  } catch (err) {
    toast.error(errorText(err, t("pricing.errors.toggle")));
  } finally {
    setBusy(rule.id, false);
  }
}

async function remove(rule: ModelPricingRule) {
  setBusy(rule.id, true);
  try {
    await apiJson<{ deleted: boolean }>(`/api/v1/admin/pricing/${encodeURIComponent(rule.id)}`, {
      method: "DELETE",
      fallbackError: t("pricing.errors.delete"),
    });
    rules.value = rules.value.filter((r) => r.id !== rule.id);
    toast.success(t("pricing.notice.deleted", { pattern: rule.pattern }));
  } catch (err) {
    toast.error(errorText(err, t("pricing.errors.delete")));
  } finally {
    setBusy(rule.id, false);
  }
}

onMounted(refresh);
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.pricing')">
      <template #meta>
        <UiBadge v-if="loaded" :tone="enabledCount > 0 ? 'accent' : 'neutral'" dot>
          {{ t("pricing.meta", { enabled: enabledCount, total: rules.length }) }}
        </UiBadge>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="refresh">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-secondary" :disabled="syncingPresets" @click="syncPresets">
          <UiIcon :name="syncingPresets ? 'loader' : 'download'" :size="15" :spin="syncingPresets" />
          <span class="hidden sm:inline">{{ t("pricing.actions.syncPresets") }}</span>
        </button>
        <button type="button" class="btn btn-primary" @click="openCreate()">
          <UiIcon name="plus" :size="15" />
          {{ t("pricing.actions.create") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:gap-6 lg:grid-cols-5">
      <PricingExplainer class="lg:col-span-3" />
      <PriceTesterCard
        class="lg:col-span-2"
        :rules="rules"
        :groups="groups"
        @match="testerMatchId = $event"
        @edit="openEdit"
        @create="openCreate"
      />
    </div>

    <UiAlert v-if="loadError && !loaded" tone="danger" :title="t('pricing.errors.load')">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0 self-start" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="14" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </UiAlert>
    <PricingRulesCard
      v-else
      :rules="rules"
      :loading="loading"
      :loaded="loaded"
      :busy-ids="busyIds"
      :highlight-id="testerMatchId"
      @create="openCreate()"
      @sync-presets="syncPresets"
      @edit="openEdit"
      @toggle="toggle"
      @remove="remove"
    />

    <BuiltinRatesCard @override="overrideTier" />

    <PricingRuleModal
      v-model:open="modalOpen"
      :rule="editing"
      :preset="preset"
      :rules="rules"
      :groups="groups"
      @saved="onSaved"
    />
  </div>
</template>
