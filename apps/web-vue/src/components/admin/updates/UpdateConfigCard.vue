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
  /** Release deployments confirm a policy change with the password (the page opens the dialog). */
  stepUpRequired: boolean;
}>();

const emit = defineEmits<{
  (e: "save", patch: UpdateSystemConfigRequest): void;
}>();

const { t } = useI18n();

interface PolicyForm {
  channel: SystemUpdateChannel;
  autoSyncEnabled: boolean;
  intervalSeconds: number;
  autoRestartAfterUpdate: boolean;
  drainTimeoutSeconds: number;
  strategy: DevSyncStrategy;
}

const DEFAULT_POLICY: PolicyForm = {
  channel: "stable",
  autoSyncEnabled: false,
  intervalSeconds: 3600,
  autoRestartAfterUpdate: true,
  drainTimeoutSeconds: 30,
  strategy: "auto",
};

function policyOf(status: SystemUpdateStatus | null): PolicyForm {
  if (!status) return { ...DEFAULT_POLICY };
  return {
    channel: status.channel,
    autoSyncEnabled: status.autoSyncEnabled,
    intervalSeconds: status.intervalSeconds > 0 ? status.intervalSeconds : 3600,
    autoRestartAfterUpdate: status.autoRestartAfterUpdate ?? true,
    drainTimeoutSeconds: status.drainTimeoutSeconds > 0 ? status.drainTimeoutSeconds : 30,
    strategy: status.strategy,
  };
}

function samePolicy(a: PolicyForm, b: PolicyForm): boolean {
  return (Object.keys(a) as (keyof PolicyForm)[]).every((key) => a[key] === b[key]);
}

const serverPolicy = computed(() => policyOf(props.status));
const form = reactive<PolicyForm>({ ...serverPolicy.value });
const dirty = computed(() => !samePolicy(form, serverPolicy.value));

// Status is polled while the page is open: follow server-side policy changes, but never
// overwrite edits the admin has not saved yet.
watch(serverPolicy, (next, prev) => {
  if (!prev || samePolicy(form, prev)) Object.assign(form, next);
});

function resetForm() {
  Object.assign(form, serverPolicy.value);
}

/** What scheduled runs do with the selected channel in this deployment mode. */
const autoSyncHint = computed(() => {
  if (props.status?.mode !== "dev") return t("updates.policy.autoSyncHintRelease");
  return form.channel === "dev" ? t("updates.policy.autoSyncHintDevApply") : t("updates.policy.autoSyncHintDevCheckOnly");
});

const drainPresets = [15, 30, 60, 120];

/** Git builds need a source checkout and git on the host; keep a saved "git" selectable as-is. */
const gitBlocked = computed(
  () => props.status !== null && !props.status.gitAvailable && serverPolicy.value.strategy !== "git",
);

const strategyOptions = computed(() => [
  { value: "auto" as const, label: t("updates.strategies.auto") },
  { value: "release" as const, label: t("updates.strategies.release") },
  { value: "git" as const, label: t("updates.strategies.git"), disabled: gitBlocked.value },
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
  const drain = Math.min(600, Math.max(5, Math.round(form.drainTimeoutSeconds || 30)));
  form.drainTimeoutSeconds = drain;
  emit("save", {
    channel: form.channel,
    autoSyncEnabled: form.autoSyncEnabled,
    intervalSeconds: clamped,
    autoRestartAfterUpdate: form.autoRestartAfterUpdate,
    drainTimeoutSeconds: drain,
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
        <p v-if="gitBlocked" class="flex items-center gap-1.5 text-2xs text-fg-subtle">
          <UiIcon name="info" :size="12" />
          {{ t("updates.policy.gitUnavailable") }}
        </p>
      </div>

      <!-- Auto-check/sync toggle & interval -->
      <div class="grid gap-5 rounded-xl border border-line bg-surface-2/40 p-4 sm:grid-cols-2">
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-semibold text-fg">{{ t("updates.policy.autoSyncLabel") }}</span>
            <UiSwitch v-model="form.autoSyncEnabled" :disabled="saving" />
          </div>
          <p class="text-xs leading-relaxed text-fg-muted">{{ autoSyncHint }}</p>
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

      <!-- Graceful full-service restart: auto-restart toggle & drain window -->
      <div class="space-y-4 rounded-xl border border-line bg-surface-2/40 p-4">
        <div class="flex items-center justify-between gap-4">
          <div class="space-y-1">
            <span class="text-xs font-semibold text-fg">{{ t("updates.policy.autoRestartLabel") }}</span>
            <p class="text-xs leading-relaxed text-fg-muted">{{ t("updates.policy.autoRestartHint") }}</p>
          </div>
          <UiSwitch v-model="form.autoRestartAfterUpdate" :disabled="saving" />
        </div>

        <div class="space-y-2 border-t border-line pt-4">
          <span class="text-xs font-semibold text-fg">{{ t("updates.policy.drainLabel") }}</span>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model.number="form.drainTimeoutSeconds"
              type="number"
              min="5"
              max="600"
              class="input w-28 font-mono"
              :disabled="saving"
            />
            <span class="text-xs text-fg-subtle">{{ t("updates.policy.intervalUnit") }}</span>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="sec in drainPresets"
                :key="sec"
                type="button"
                class="btn btn-xs"
                :class="form.drainTimeoutSeconds === sec ? 'btn-primary' : 'btn-secondary'"
                :disabled="saving"
                @click="form.drainTimeoutSeconds = sec"
              >
                {{ t("updates.policy.drainPreset", { seconds: sec }) }}
              </button>
            </div>
          </div>
          <p class="text-xs leading-relaxed text-fg-muted">{{ t("updates.policy.drainHint") }}</p>
        </div>
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

      <div class="flex flex-wrap items-center justify-end gap-2">
        <span v-if="dirty && !saving" class="mr-auto inline-flex items-center gap-1.5 text-2xs text-warning">
          <span class="h-1.5 w-1.5 rounded-full bg-warning" />
          {{ t("updates.policy.unsaved") }}
        </span>
        <span v-if="stepUpRequired" class="inline-flex items-center gap-1 text-2xs text-fg-subtle">
          <UiIcon name="shield" :size="12" />
          {{ t("updates.policy.stepUpOnSave") }}
        </span>
        <button type="button" class="btn btn-secondary" :disabled="!dirty || saving" @click="resetForm">
          {{ t("updates.policy.reset") }}
        </button>
        <button type="submit" class="btn btn-primary" :disabled="!dirty || saving">
          <UiIcon :name="saving ? 'loader' : 'check'" :size="15" :spin="saving" />
          {{ saving ? t("common.saving") : t("updates.policy.save") }}
        </button>
      </div>
    </form>
  </UiCard>
</template>
