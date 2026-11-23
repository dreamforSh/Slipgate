<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { OAuthProviderConfig, OAuthProviderId } from "@slipgate/contracts";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import OAuthProviderCard from "./OAuthProviderCard.vue";
import { oauthCallbackUrl, oauthStatus, type OAuthFieldKey, type OAuthProviderForm } from "./oauthForm";

/**
 * "Third-party sign-in" settings tab: how matching works plus one card per provider.
 * Edits stay in the parent's forms so the page's sticky save bar saves them (one PATCH per
 * changed provider) together with the other tabs.
 */
const forms = defineModel<OAuthProviderForm[]>({ required: true });
const props = defineProps<{
  /** Providers as saved on the server. */
  saved: OAuthProviderConfig[];
  dirty: Partial<Record<OAuthProviderId, OAuthFieldKey[]>>;
  errors: Partial<Record<OAuthProviderId, Partial<Record<OAuthFieldKey, string>>>>;
  /** Portal "API base URL" as currently edited (callback URLs derive from it). */
  apiBaseUrl: string;
  /** Portal allows self sign-up without an invite code (as currently edited). */
  registrationOpen: boolean;
}>();
const emit = defineEmits<{ (e: "open-registration"): void }>();

const { t } = useI18n();
const origin = window.location.origin;

const rows = computed(() => {
  const byId = new Map(props.saved.map((s) => [s.id, s]));
  return forms.value.flatMap((form, index) => {
    const saved = byId.get(form.id);
    return saved ? [{ index, id: form.id, form, saved, callbackUrl: oauthCallbackUrl(props.apiBaseUrl, origin, form.id) }] : [];
  });
});

const activeCount = computed(() => props.saved.filter((s) => oauthStatus(s) === "active").length);

const NOTES: { key: string; icon: IconName; chip: string }[] = [
  { key: "email", icon: "mail", chip: "icon-chip-info" },
  { key: "totp", icon: "shield", chip: "icon-chip-warning" },
  { key: "signup", icon: "user-plus", chip: "icon-chip-success" },
];

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 5) * 60}ms`, animationFillMode: "both" });
</script>

<template>
  <div class="space-y-6">
    <!-- ============ How it works ============ -->
    <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(0)" icon="log-in" :title="t('settings.oauth.introTitle')">
      <template #actions>
        <UiBadge :tone="activeCount ? 'success' : 'neutral'" dot>
          {{ t("settings.oauth.activeCount", { n: activeCount, total: saved.length }) }}
        </UiBadge>
      </template>
      <ul class="grid gap-4 md:grid-cols-3">
        <li v-for="note in NOTES" :key="note.key" class="flex min-w-0 items-start gap-3">
          <span class="icon-chip mt-0.5 h-8 w-8" :class="note.chip"><UiIcon :name="note.icon" :size="15" /></span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-fg">{{ t(`settings.oauth.notes.${note.key}.title`) }}</p>
            <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ t(`settings.oauth.notes.${note.key}.body`) }}</p>
            <button
              v-if="note.key === 'signup'"
              type="button"
              class="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-accent hover:underline"
              @click="emit('open-registration')"
            >
              {{ t("settings.oauth.manageRegistration") }}
              <UiIcon name="arrow-right" :size="12" />
            </button>
          </div>
        </li>
      </ul>
    </UiCard>

    <!-- ============ Providers ============ -->
    <div class="grid items-start gap-6 xl:grid-cols-2">
      <OAuthProviderCard
        v-for="(row, i) in rows"
        :key="row.id"
        :model-value="row.form"
        class="animate-slide-up motion-reduce:animate-none"
        :style="stagger(i + 1)"
        :saved="row.saved"
        :dirty-keys="dirty[row.id] ?? []"
        :errors="errors[row.id] ?? {}"
        :callback-url="row.callbackUrl"
        :registration-open="registrationOpen"
        @update:model-value="forms[row.index] = $event"
        @open-registration="emit('open-registration')"
      />
    </div>
  </div>
</template>
