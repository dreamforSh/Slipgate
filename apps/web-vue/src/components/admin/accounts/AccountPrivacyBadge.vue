<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { isPrivacyApplied, type UpstreamAccount } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { formatRelative } from "../../../lib/format";

/** Outcome of the last "set privacy" action; nothing while it has never run. */
const props = defineProps<{
  account: Pick<UpstreamAccount, "privacyMode" | "privacyCheckedAtIso">;
}>();

const { t } = useI18n();

const view = computed(() => {
  const mode = props.account.privacyMode;
  if (!mode) return null;
  if (isPrivacyApplied(mode)) {
    return {
      icon: "shield" as const,
      class: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    };
  }
  if (mode === "training_set_cf_blocked") {
    return { icon: "shield-alert" as const, class: "bg-danger/10 text-danger" };
  }
  return { icon: "shield-alert" as const, class: "bg-warning/10 text-warning" };
});

const title = computed(() => {
  const mode = props.account.privacyMode;
  if (!mode) return "";
  const at = props.account.privacyCheckedAtIso;
  const detail = t(`accounts.privacy.mode.${mode}`);
  return at ? `${detail} · ${t("accounts.privacy.checkedAt", { time: formatRelative(at) })}` : detail;
});
</script>

<template>
  <span
    v-if="view && account.privacyMode"
    class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-2xs font-medium"
    :class="view.class"
    :title="title"
  >
    <UiIcon :name="view.icon" :size="11" />
    {{ t(`accounts.privacy.badge.${account.privacyMode}`) }}
  </span>
</template>
