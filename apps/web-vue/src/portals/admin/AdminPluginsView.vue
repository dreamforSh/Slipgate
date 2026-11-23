<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { STAGGER_CLASS, stagger } from "../../components/admin/ops/opsUtil";
import PluginCard from "../../components/admin/tools/PluginCard.vue";
import PluginEmptyState from "../../components/admin/tools/PluginEmptyState.vue";
import type { PluginItem, PluginListResponse } from "../../components/admin/tools/toolsTypes";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { apiJson, errorText } from "../../lib/api";

const { t } = useI18n();

const items = ref<PluginItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);

const enabledCount = computed(() => items.value.filter((p) => p.enabled).length);

async function load() {
  loading.value = true;
  try {
    items.value = (
      await apiJson<PluginListResponse>("/api/v1/admin/plugins", { fallbackError: t("adminTools.plugins.errors.load") })
    ).items;
    loaded.value = true;
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("adminTools.plugins.errors.load"));
  } finally {
    loading.value = false;
  }
}

function onUpdated(item: PluginItem) {
  items.value = items.value.map((p) => (p.name === item.name ? item : p));
}

onMounted(() => void load());
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.plugins')">
      <template #meta>
        <UiBadge v-if="loaded && items.length" :tone="enabledCount ? 'accent' : 'neutral'">
          {{ t("adminTools.plugins.count", { n: items.length, enabled: enabledCount }) }}
        </UiBadge>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
      </template>
    </PageHeader>

    <p class="-mt-2 max-w-3xl text-sm leading-relaxed text-fg-muted">{{ t("adminTools.plugins.intro") }}</p>

    <UiAlert v-if="loadError" tone="danger">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs shrink-0" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="13" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </UiAlert>

    <!-- First load -->
    <div v-if="!loaded && loading" class="grid items-start gap-4 xl:grid-cols-2" aria-busy="true" role="status">
      <div v-for="i in 2" :key="i" class="card p-5 motion-safe:animate-pulse" :style="{ animationDelay: `${(i - 1) * 120}ms` }">
        <div class="flex items-start gap-3">
          <span class="h-10 w-10 shrink-0 rounded-lg bg-surface-2" />
          <div class="min-w-0 flex-1 space-y-2.5">
            <span class="block h-3 w-1/3 rounded-full bg-surface-2" />
            <span class="block h-2.5 w-3/4 rounded-full bg-surface-2/70" />
            <span class="block h-4 w-24 rounded-full bg-surface-2/70" />
          </div>
          <span class="h-[18px] w-8 shrink-0 rounded-full bg-surface-2" />
        </div>
      </div>
      <span class="sr-only">{{ t("common.loading") }}</span>
    </div>

    <PluginEmptyState v-else-if="loaded && items.length === 0" />

    <div v-else-if="items.length" class="grid items-start gap-4 xl:grid-cols-2">
      <PluginCard
        v-for="(plugin, i) in items"
        :key="plugin.name"
        :plugin="plugin"
        :class="STAGGER_CLASS"
        :style="stagger(i, 50)"
        @updated="onUpdated"
      />
    </div>
  </div>
</template>
