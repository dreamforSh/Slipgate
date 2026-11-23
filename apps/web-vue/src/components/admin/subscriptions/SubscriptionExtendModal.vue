<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UserSubscriptionItem } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { formatDateTime } from "../../../lib/format";
import { previewExpiry } from "./subscriptionDisplay";

/** Lengthen or shorten one or many subscriptions; the parent performs the request. */
const props = defineProps<{
  targets: UserSubscriptionItem[];
  busy: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "confirm", days: number): void }>();

const { t } = useI18n();

const days = ref<number>(30);
const PRESETS = [-7, 7, 30, 90, 365];

watch(open, (isOpen) => {
  if (isOpen) days.value = 30;
});

const valid = computed(() => Number.isInteger(days.value) && days.value !== 0 && Math.abs(days.value) <= 3650);
const single = computed(() => (props.targets.length === 1 ? props.targets[0] : null));
const preview = computed(() => (single.value && valid.value ? previewExpiry(single.value.expiresAtIso, days.value, Date.now()) : null));

function submit() {
  if (!valid.value || props.busy) return;
  emit("confirm", days.value);
}
</script>

<template>
  <UiModal
    v-model:open="open"
    width="sm"
    :persistent="busy"
    :title="single ? t('subscriptions.extend.title') : t('subscriptions.extend.titleBulk', { n: targets.length })"
  >
    <template #icon>
      <span class="icon-chip icon-chip-info h-8 w-8">
        <UiIcon name="calendar" :size="15" />
      </span>
    </template>

    <form id="subscription-extend" class="space-y-4" @submit.prevent="submit">
      <div v-if="single" class="rounded-lg border border-line bg-surface-2/40 px-3.5 py-2.5 text-xs">
        <p class="truncate font-medium text-fg">{{ single.userEmail }}</p>
        <p class="mt-0.5 truncate text-fg-subtle">{{ single.groupName }}</p>
      </div>

      <FormField :label="t('subscriptions.extend.days')" required>
        <input v-model.number="days" type="number" step="1" min="-3650" max="3650" required class="input font-mono" />
      </FormField>
      <div class="-mt-2 flex flex-wrap gap-1.5">
        <button
          v-for="p in PRESETS"
          :key="p"
          type="button"
          class="btn btn-xs font-mono tabular-nums"
          :class="days === p ? 'btn-primary' : 'btn-secondary'"
          @click="days = p"
        >
          {{ p > 0 ? `+${p}` : p }}
        </button>
      </div>
      <p class="hint" :class="valid ? '' : '!text-danger'">
        {{ valid ? t("subscriptions.extend.daysHint") : t("subscriptions.extend.invalid") }}
      </p>

      <dl v-if="single" class="grid grid-cols-2 gap-3 rounded-lg border border-line/70 px-3.5 py-3 text-xs">
        <div>
          <dt class="text-fg-subtle">{{ t("subscriptions.extend.current") }}</dt>
          <dd class="mt-0.5 font-mono tabular-nums text-fg-muted">{{ formatDateTime(single.expiresAtIso) }}</dd>
        </div>
        <div>
          <dt class="text-fg-subtle">{{ t("subscriptions.extend.preview") }}</dt>
          <dd
            class="mt-0.5 font-mono font-semibold tabular-nums transition-colors"
            :class="!preview ? 'text-fg-subtle' : days > 0 ? 'text-success' : 'text-warning'"
          >
            {{ preview ? formatDateTime(preview.toISOString()) : "—" }}
          </dd>
        </div>
      </dl>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">
        {{ t("common.cancel") }}
      </button>
      <button type="submit" form="subscription-extend" class="btn btn-primary" :disabled="busy || !valid">
        <UiIcon v-if="busy" name="loader" :size="15" spin />
        {{ t("subscriptions.extend.submit") }}
      </button>
    </template>
  </UiModal>
</template>
