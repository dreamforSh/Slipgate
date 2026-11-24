<script setup lang="ts">
import { computed } from "vue";
import type { SystemUpdateComponent, SystemUpdateStatus } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import type { Tone } from "../../../lib/format";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";

const props = defineProps<{
  status: SystemUpdateStatus | null;
}>();

const { t } = useI18n();

const componentIcons: Record<SystemUpdateComponent["name"], IconName> = {
  edge: "globe",
  core: "cpu",
  bff: "server",
  guestd: "terminal",
  webui: "layers",
};

const components = computed<SystemUpdateComponent[]>(() => {
  if (props.status?.components?.length) {
    return props.status.components;
  }
  return [
    { name: "edge", status: "unknown", binaryPath: null, overridden: false, restartRequired: false, pid: 0, lastError: null },
    { name: "core", status: "unknown", binaryPath: null, overridden: false, restartRequired: false, pid: 0, lastError: null },
    { name: "bff", status: "unknown", binaryPath: null, overridden: false, restartRequired: false, pid: 0, lastError: null },
    { name: "guestd", status: "unknown", binaryPath: null, overridden: false, restartRequired: false, pid: 0, lastError: null },
    {
      name: "webui",
      status: props.status?.webUiOverridden ? "overridden" : "embedded",
      binaryPath: null,
      overridden: Boolean(props.status?.webUiOverridden),
      restartRequired: false,
      pid: 0,
      lastError: null,
    },
  ];
});

function statusTone(item: SystemUpdateComponent): Tone {
  switch (item.status) {
    case "running":
    case "overridden":
      return "success";
    case "staged":
    case "degraded":
      return "warning";
    case "pending":
    case "embedded":
      return "info";
    case "stopped":
      return "danger";
    default:
      return "neutral";
  }
}
</script>

<template>
  <UiCard icon="layers" :title="t('updates.components.title')">
    <template #actions>
      <UiBadge tone="neutral" mono>
        {{ t("updates.components.reloads", { count: status?.reloadCount ?? 0 }) }}
      </UiBadge>
    </template>

    <p class="mb-3 text-xs text-fg-muted">{{ t("updates.components.subtitle") }}</p>

    <div class="space-y-2.5">
      <div
        v-for="item in components"
        :key="item.name"
        class="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5"
      >
        <div class="flex min-w-0 items-start gap-2.5">
          <span class="icon-chip mt-0.5 h-8 w-8">
            <UiIcon :name="componentIcons[item.name]" :size="15" />
          </span>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-xs font-semibold text-fg">
                {{ t(`updates.components.names.${item.name}`) }}
              </span>
              <UiBadge v-if="item.overridden" tone="accent">
                {{ item.name === "webui" ? t("updates.components.overridden") : t("updates.components.staged") }}
              </UiBadge>
              <UiBadge v-if="item.restartRequired" tone="warning">
                {{ t("updates.components.restartRequired") }}
              </UiBadge>
            </div>
            <p
              v-if="item.binaryPath"
              class="mt-0.5 truncate font-mono text-2xs text-fg-subtle"
              :title="item.binaryPath"
            >
              {{ item.binaryPath }}
            </p>
            <p v-if="item.lastError" class="mt-0.5 font-mono text-2xs text-danger">
              {{ item.lastError }}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 flex-col items-end gap-1">
          <UiBadge :tone="statusTone(item)" dot>
            {{ t(`updates.components.statusLabels.${item.status}`) }}
          </UiBadge>
          <span v-if="item.pid > 0" class="font-mono text-2xs text-fg-subtle tabular-nums">
            {{ t("updates.components.pid", { pid: item.pid }) }}
          </span>
        </div>
      </div>
    </div>
  </UiCard>
</template>
