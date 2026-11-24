<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type {
  DevSyncStrategy,
  SystemUpdateChannel,
  SystemUpdateStatus,
  UpdateSystemConfigRequest,
} from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";

const props = defineProps<{
  status: SystemUpdateStatus | null;
  saving: boolean;
}>();

const emit = defineEmits<{
  (e: "save", patch: UpdateSystemConfigRequest): void;
}>();

const { t } = useI18n();

const form = reactive<{
  channel: SystemUpdateChannel;
  autoSyncEnabled: boolean;
  intervalSeconds: number;
  strategy: DevSyncStrategy;
}>({
  channel: "stable",
  autoSyncEnabled: false,
  intervalSeconds: 3600,
  strategy: "auto",
});

watch(
  () => props.status,
  (next) => {
    if (!next) return;
    form.channel = next.channel;
    form.autoSyncEnabled = next.autoSyncEnabled;
    form.intervalSeconds = next.intervalSeconds > 0 ? next.intervalSeconds : 3600;
    form.strategy = next.strategy;
  },
  { immediate: true },
);

const strategyOptions = computed(() => [
  { value: "auto" as const, label: t("updates.strategies.auto") },
  { value: "release" as const, label: t("updates.strategies.release") },
  { value: "git" as const, label: t("updates.strategies.git") },
]);

const intervalPresets = computed(() => [
  { seconds: 60, label: t("updates.policy.presets.m1") },
  { seconds: 300, label: t("updates.policy.presets.m5") },
  { seconds: 900, label: t("updates.policy.presets.m15") },
  { seconds: 3600, label: t("updates.policy.presets.h1") },
  { seconds: 21600, label: t("updates.policy.presets.h6") },
]);

function submit() {
  const clamped = Math.min(86400, Math.max(30, Math.round(form.intervalSeconds || 300)));
  form.intervalSeconds = clamped;
  emit("save", {
    channel: form.channel,
    autoSyncEnabled: form.autoSyncEnabled,
    intervalSeconds: clamped,
    strategy: form.strategy,
  });
}
</script>

<template>
  <UiCard icon="sliders" :title="t('updates.policy.title')">
    <form class="space-y-6" @submit.prevent="submit">
      <!-- Channel selection cards -->
      <div class="space-y-2">
        <span class="label">{{ t("updates.policy.channelLabel") }}</span>
        <div class="grid gap-3 sm:grid-cols-2">
          <button
            v-for="ch in (['stable', 'dev'] as const)"
            :key="ch"
            type="button"
            class="flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-all"
            :class="
              form.channel === ch
                ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                : 'border-line bg-surface-2/40 hover:border-line-strong'
            "
            @click="form.channel = ch"
          >
            <div class="flex w-full items-center justify-between gap-2">
              <span class="font-semibold text-fg">{{ t(`updates.channels.${ch}`) }}</span>
              <UiBadge :tone="form.channel === ch ? 'accent' : 'neutral'" dot>
                {{ t(`updates.channels.${ch === "dev" ? "shortDev" : "shortStable"}`) }}
              </UiBadge>
            </div>
            <p class="text-xs leading-relaxed text-fg-muted">{{ t(`updates.channels.${ch}Desc`) }}</p>
          </button>
        </div>
      </div>

      <!-- Sync strategy -->
      <div class="space-y-2">
        <span class="label">{{ t("updates.policy.strategyLabel") }}</span>
        <SegmentedControl v-model="form.strategy" :options="strategyOptions" size="md" />
        <p class="text-xs text-fg-subtle">{{ t("updates.policy.strategyHint") }}</p>
      </div>

      <!-- Auto-check/sync toggle & interval -->
      <div class="grid gap-5 rounded-xl border border-line bg-surface-2/40 p-4 sm:grid-cols-2">
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-semibold text-fg">{{ t("updates.policy.autoSyncLabel") }}</span>
            <UiSwitch v-model="form.autoSyncEnabled" :disabled="saving" />
          </div>
          <p class="text-xs leading-relaxed text-fg-muted">
            {{
              status?.mode === "dev"
                ? t("updates.policy.autoSyncHintDev")
                : t("updates.policy.autoSyncHintRelease")
            }}
          </p>
        </div>

        <FormField :label="t('updates.policy.intervalLabel')">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <input
                v-model.number="form.intervalSeconds"
                type="number"
                min="30"
                max="86400"
                class="input w-32 font-mono"
                :disabled="!form.autoSyncEnabled || saving"
              />
              <span class="text-xs text-fg-subtle">{{ t("updates.policy.intervalUnit") }}</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="p in intervalPresets"
                :key="p.seconds"
                type="button"
                class="btn btn-xs"
                :class="form.intervalSeconds === p.seconds ? 'btn-primary' : 'btn-secondary'"
                :disabled="!form.autoSyncEnabled || saving"
                @click="form.intervalSeconds = p.seconds"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
        </FormField>
      </div>

      <!-- Repository & credentials read-only diagnostics -->
      <div class="space-y-2.5">
        <span class="label">{{ t("updates.policy.envSection") }}</span>
        <dl class="kv grid-cols-1 sm:grid-cols-3">
          <div>
            <dt>{{ t("updates.policy.repo") }}</dt>
            <dd class="font-mono">{{ status?.repo ?? "dreamforSh/Slipgate" }}</dd>
          </div>
          <div>
            <dt>{{ t("updates.policy.branch") }}</dt>
            <dd class="font-mono">{{ status?.branch ?? "main" }}</dd>
          </div>
          <div>
            <dt>{{ t("updates.policy.githubToken") }}</dt>
            <dd>
              <UiBadge :tone="status?.githubTokenConfigured ? 'success' : 'warning'" dot>
                {{
                  status?.githubTokenConfigured
                    ? t("updates.policy.tokenConfigured")
                    : t("updates.policy.tokenUnconfigured")
                }}
              </UiBadge>
            </dd>
          </div>
        </dl>
      </div>

      <div class="flex justify-end">
        <button type="submit" class="btn btn-primary" :disabled="saving">
          <UiIcon :name="saving ? 'loader' : 'check'" :size="15" :spin="saving" />
          {{ saving ? t("common.saving") : t("updates.policy.save") }}
        </button>
      </div>
    </form>
  </UiCard>
</template>
