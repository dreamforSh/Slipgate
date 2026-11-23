<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import SettingSwitchRow from "./SettingSwitchRow.vue";

/**
 * Settings → Sign-in security: backend (admin-only) mode. Sign-up, self-service and the public
 * pages close and only administrators can sign in; API keys keep serving traffic.
 */
const enabled = defineModel<boolean>({ required: true });
const props = defineProps<{
  /** As saved on the server. */
  saved: boolean;
  dirty: boolean;
}>();

const { t } = useI18n();

const effects = computed<{ icon: IconName; text: string; keeps?: boolean }[]>(() => [
  { icon: "user-plus", text: t("authGuards.settings.backendMode.effects.signup") },
  { icon: "log-in", text: t("authGuards.settings.backendMode.effects.signin") },
  { icon: "globe", text: t("authGuards.settings.backendMode.effects.public") },
  { icon: "key", text: t("authGuards.settings.backendMode.effects.keys"), keeps: true },
]);

/** Switched on here but not saved yet: say what saving will do. */
const pendingOn = computed(() => enabled.value && !props.saved);
</script>

<template>
  <UiCard icon="lock" :title="t('authGuards.settings.backendMode.title')">
    <template #actions>
      <UiBadge :tone="saved ? 'warning' : 'neutral'" dot :pulse="saved">
        {{ saved ? t("authGuards.settings.backendMode.on") : t("authGuards.settings.backendMode.off") }}
      </UiBadge>
    </template>

    <SettingSwitchRow
      v-model="enabled"
      icon="shield-alert"
      tone="warning"
      :title="t('authGuards.settings.backendMode.switch')"
      :description="t('authGuards.settings.backendMode.help')"
      :dirty="dirty"
    />

    <ul class="mt-4 grid gap-2 sm:grid-cols-2">
      <li
        v-for="e in effects"
        :key="e.icon"
        class="flex items-start gap-2.5 rounded-lg border border-line/70 bg-surface-2/30 px-3 py-2.5 text-xs leading-relaxed transition-opacity duration-200"
        :class="enabled || e.keeps ? 'text-fg-muted' : 'text-fg-subtle opacity-70'"
      >
        <span class="icon-chip mt-px h-6 w-6" :class="e.keeps ? 'icon-chip-success' : enabled ? 'icon-chip-warning' : ''">
          <UiIcon :name="e.keeps ? 'check' : e.icon" :size="13" />
        </span>
        <span class="min-w-0">{{ e.text }}</span>
      </li>
    </ul>

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      enter-from-class="-translate-y-1 opacity-0"
      leave-to-class="opacity-0"
    >
      <UiAlert v-if="pendingOn" tone="warning" class="mt-4" :title="t('authGuards.settings.backendMode.pendingTitle')">
        {{ t("authGuards.settings.backendMode.pendingBody") }}
      </UiAlert>
      <p v-else-if="saved && !enabled" class="mt-4 flex items-start gap-1.5 text-xs text-fg-subtle">
        <UiIcon name="info" :size="13" class="mt-px shrink-0" />
        {{ t("authGuards.settings.backendMode.pendingOff") }}
      </p>
    </Transition>
  </UiCard>
</template>
