<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { apiJson } from "../../lib/api";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import TotpDisableModal from "./TotpDisableModal.vue";
import TotpEnableModal from "./TotpEnableModal.vue";

/** Profile card for two-factor sign-in (TOTP): status plus the enable / disable flows. */
const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const checking = ref(false);
const enableOpen = ref(false);
const disableOpen = ref(false);

const enabled = computed(() => auth.user?.totpEnabled === true);

onMounted(async () => {
  // The session copy can be stale (another device toggled it); the server is the source of truth.
  checking.value = true;
  try {
    const res = await apiJson<{ enabled: boolean }>("/api/v1/user/totp");
    if (auth.user && auth.user.totpEnabled !== res.enabled) auth.user.totpEnabled = res.enabled;
  } catch {
    // Keep the session value.
  } finally {
    checking.value = false;
  }
});

function onEnabled() {
  toast.success(t("security.totp.enabledToast"));
}
function onDisabled() {
  toast.success(t("security.totp.disabledToast"));
}
</script>

<template>
  <UiCard icon="shield" :title="t('security.totp.title')">
    <template #actions>
      <UiBadge v-if="!checking" :tone="enabled ? 'success' : 'neutral'" dot :pulse="enabled">
        {{ enabled ? t("security.totp.on") : t("security.totp.off") }}
      </UiBadge>
      <UiIcon v-else name="loader" :size="14" spin class="text-fg-subtle" />
    </template>

    <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
      <span
        class="icon-chip h-12 w-12 rounded-xl transition-colors duration-300"
        :class="enabled ? 'icon-chip-success' : 'icon-chip-warning'"
        aria-hidden="true"
      >
        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out"
          leave-active-class="transition duration-100 ease-in"
          enter-from-class="scale-75 opacity-0"
          leave-to-class="scale-75 opacity-0"
        >
          <UiIcon :key="String(enabled)" :name="enabled ? 'badge-check' : 'shield-alert'" :size="22" />
        </Transition>
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-fg">
          {{ enabled ? t("security.totp.enabledHeadline") : t("security.totp.disabledHeadline") }}
        </p>
        <p class="mt-1 text-xs leading-relaxed text-fg-subtle">
          {{ enabled ? t("security.totp.enabledDesc") : t("security.totp.disabledDesc") }}
        </p>
      </div>
      <button
        v-if="enabled"
        type="button"
        class="btn btn-danger shrink-0"
        :disabled="checking"
        @click="disableOpen = true"
      >
        <UiIcon name="shield-alert" :size="15" />
        {{ t("security.totp.disable") }}
      </button>
      <button v-else type="button" class="btn btn-primary shrink-0" :disabled="checking" @click="enableOpen = true">
        <UiIcon name="shield" :size="15" />
        {{ t("security.totp.enable") }}
      </button>
    </div>

    <TotpEnableModal v-model:open="enableOpen" @enabled="onEnabled" />
    <TotpDisableModal v-model:open="disableOpen" @disabled="onDisabled" />
  </UiCard>
</template>
