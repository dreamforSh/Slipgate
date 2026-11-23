<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  isRegistrationEmailSuffixAllowed,
  isReservedEmail,
  normalizeEmailForAliasDedup,
  RESERVED_EMAIL_DOMAIN,
  registrationEmailDomain,
  splitEmailForPolicy,
} from "@slipgate/contracts";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import EmailSuffixChipsInput from "./EmailSuffixChipsInput.vue";
import SettingField from "./SettingField.vue";
import SettingSwitchRow from "./SettingSwitchRow.vue";
import { MAX_EMAIL_SUFFIXES, type GuardPortalKey } from "./authGuardsForm";

/**
 * Settings → Registration: which email domains may sign up (allowlist with "*." wildcards), the
 * one-account-per-other-domain quota, and a live "try an address" check of the rules as edited.
 */
const allowlist = defineModel<string[]>("allowlist", { required: true });
const quota = defineModel<boolean>("quota", { required: true });
const props = defineProps<{ dirtyKeys: GuardPortalKey[]; errors: Record<string, string> }>();

const { t } = useI18n();

const isDirty = (k: GuardPortalKey) => props.dirtyKeys.includes(k);

const summary = computed(() =>
  allowlist.value.length === 0
    ? { tone: "neutral" as const, text: t("authGuards.settings.emailPolicy.badgeOpen") }
    : { tone: "accent" as const, text: t("authGuards.settings.emailPolicy.badgeLimited", { n: allowlist.value.length }) },
);

/* ---------------- Try an address ---------------- */

const probe = ref("");

const verdict = computed<{ tone: "success" | "warning" | "danger" | "neutral"; icon: IconName; text: string; note?: string } | null>(() => {
  const raw = probe.value.trim();
  if (!raw) return null;
  const parts = splitEmailForPolicy(raw);
  if (!parts || !/\./.test(parts.domain)) return { tone: "neutral", icon: "info", text: t("authGuards.settings.emailPolicy.probe.malformed") };
  if (isReservedEmail(raw)) return { tone: "danger", icon: "x-circle", text: t("authGuards.settings.emailPolicy.probe.reserved") };
  const alias = normalizeEmailForAliasDedup(raw);
  const note = alias !== raw.toLowerCase() ? t("authGuards.settings.emailPolicy.probe.alias", { inbox: alias }) : undefined;
  if (isRegistrationEmailSuffixAllowed(raw, allowlist.value)) {
    return {
      tone: "success",
      icon: "check-circle",
      text: allowlist.value.length ? t("authGuards.settings.emailPolicy.probe.listed") : t("authGuards.settings.emailPolicy.probe.open"),
      note,
    };
  }
  if (quota.value) {
    return {
      tone: "warning",
      icon: "alert",
      text: t("authGuards.settings.emailPolicy.probe.quota", { domain: registrationEmailDomain(raw) }),
      note,
    };
  }
  return { tone: "danger", icon: "x-circle", text: t("authGuards.settings.emailPolicy.probe.blocked"), note };
});

const verdictClass: Record<string, string> = {
  success: "border-success/25 bg-success/[0.06] text-success",
  warning: "border-warning/30 bg-warning/[0.07] text-warning",
  danger: "border-danger/25 bg-danger/[0.06] text-danger",
  neutral: "border-line bg-surface-2/50 text-fg-subtle",
};
</script>

<template>
  <UiCard icon="mail" :title="t('authGuards.settings.emailPolicy.title')">
    <template #actions>
      <UiBadge :tone="summary.tone" dot>{{ summary.text }}</UiBadge>
    </template>

    <div class="grid gap-6 lg:grid-cols-5">
      <div class="min-w-0 space-y-4 lg:col-span-3">
        <SettingField
          input-id="set-email-suffixes"
          :label="t('authGuards.settings.emailPolicy.allowlist')"
          :dirty="isDirty('registrationEmailSuffixAllowlist')"
          :error="errors.registrationEmailSuffixAllowlist ?? null"
        >
          <EmailSuffixChipsInput
            v-model="allowlist"
            input-id="set-email-suffixes"
            :max="MAX_EMAIL_SUFFIXES"
            :invalid="Boolean(errors.registrationEmailSuffixAllowlist)"
          />
        </SettingField>
        <ul class="space-y-1.5 text-xs leading-relaxed text-fg-subtle">
          <li class="flex items-start gap-2">
            <span class="code-chip mt-px shrink-0">@corp.com</span>
            <span class="min-w-0">{{ t("authGuards.settings.emailPolicy.exactHelp") }}</span>
          </li>
          <li class="flex items-start gap-2">
            <span class="code-chip mt-px shrink-0">*.edu.cn</span>
            <span class="min-w-0">{{ t("authGuards.settings.emailPolicy.wildcardHelp") }}</span>
          </li>
        </ul>

        <div class="border-t border-line/70 pt-4">
          <SettingSwitchRow
            v-model="quota"
            icon="users"
            tone="info"
            :title="t('authGuards.settings.emailPolicy.quota')"
            :description="t('authGuards.settings.emailPolicy.quotaHelp')"
            :dirty="isDirty('registrationEmailDomainQuotaEnabled')"
          >
            <Transition
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
              enter-from-class="-translate-y-0.5 opacity-0"
              leave-to-class="opacity-0"
            >
              <p v-if="quota && allowlist.length === 0" class="mt-1.5 flex items-center gap-1 text-2xs text-warning">
                <UiIcon name="info" :size="11" />
                {{ t("authGuards.settings.emailPolicy.quotaInactive") }}
              </p>
            </Transition>
          </SettingSwitchRow>
        </div>
      </div>

      <div class="min-w-0 space-y-4 lg:col-span-2">
        <div class="rounded-xl border border-line bg-surface-2/30 p-4">
          <label for="set-email-probe" class="text-xs font-medium text-fg-muted">{{ t("authGuards.settings.emailPolicy.probe.label") }}</label>
          <div class="relative mt-1.5">
            <UiIcon name="search" :size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              id="set-email-probe"
              v-model="probe"
              type="email"
              autocomplete="off"
              spellcheck="false"
              class="input pl-8 font-mono"
              placeholder="alice+news@g.mail.edu.cn"
            />
          </div>
          <Transition
            mode="out-in"
            enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            enter-from-class="-translate-y-0.5 opacity-0"
            leave-to-class="opacity-0"
          >
            <div
              v-if="verdict"
              :key="verdict.text"
              class="mt-3 rounded-lg border px-3 py-2.5 text-xs"
              :class="verdictClass[verdict.tone]"
              aria-live="polite"
            >
              <p class="flex items-start gap-1.5 font-medium">
                <UiIcon :name="verdict.icon" :size="13" class="mt-px shrink-0" />
                <span class="min-w-0 break-words text-fg">{{ verdict.text }}</span>
              </p>
              <p v-if="verdict.note" class="mt-1 break-all pl-[1.1rem] text-fg-subtle">{{ verdict.note }}</p>
            </div>
            <p v-else class="mt-3 text-xs text-fg-subtle">{{ t("authGuards.settings.emailPolicy.probe.hint") }}</p>
          </Transition>
        </div>

        <ul class="space-y-2 text-xs leading-relaxed text-fg-subtle">
          <li class="flex items-start gap-2">
            <UiIcon name="shield" :size="13" class="mt-0.5 shrink-0 text-success" />
            <span class="min-w-0">{{ t("authGuards.settings.emailPolicy.aliasNote") }}</span>
          </li>
          <li class="flex items-start gap-2">
            <UiIcon name="lock" :size="13" class="mt-0.5 shrink-0 text-fg-subtle" />
            <span class="min-w-0">{{ t("authGuards.settings.emailPolicy.reservedNote", { domain: RESERVED_EMAIL_DOMAIN }) }}</span>
          </li>
          <li class="flex items-start gap-2">
            <UiIcon name="user" :size="13" class="mt-0.5 shrink-0 text-fg-subtle" />
            <span class="min-w-0">{{ t("authGuards.settings.emailPolicy.adminNote") }}</span>
          </li>
        </ul>
      </div>
    </div>
  </UiCard>
</template>
