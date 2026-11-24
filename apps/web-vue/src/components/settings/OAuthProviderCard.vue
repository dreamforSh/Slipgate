<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OAuthProviderConfig } from "@slipgate/contracts";
import CopyButton from "../ui/CopyButton.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import OAuthProviderMark from "./OAuthProviderMark.vue";
import SettingField from "./SettingField.vue";
import SettingSwitchRow from "./SettingSwitchRow.vue";
import {
  OAUTH_ADVANCED_FIELDS,
  OAUTH_CONSOLE_URLS,
  OAUTH_DEFAULT_NAMES,
  OAUTH_ENDPOINTS,
  OAUTH_LIMITS,
  oauthMissing,
  oauthStatus,
  type OAuthFieldKey,
  type OAuthProviderForm,
} from "./oauthForm";

/**
 * One third-party sign-in provider: switch, credentials, callback URL, sign-up policy and an
 * "Advanced" disclosure with endpoints and userinfo field paths. Edits stay in the parent's form
 * so the page's sticky save bar saves them with everything else.
 */
const form = defineModel<OAuthProviderForm>({ required: true });
const props = defineProps<{
  /** Configuration as saved on the server (what sign-in actually uses). */
  saved: OAuthProviderConfig;
  dirtyKeys: OAuthFieldKey[];
  errors: Partial<Record<OAuthFieldKey, string>>;
  /** Redirect URI to register at the provider. */
  callbackUrl: string;
  /** Portal allows self sign-up without an invite code (as currently edited). */
  registrationOpen: boolean;
}>();
const emit = defineEmits<{ (e: "open-registration"): void }>();

const { t } = useI18n();

const idp = computed(() => `oauth-${form.value.id}`);
const errorClass = "!border-danger/60 focus:!ring-danger/20";
const warnClass = "!border-warning/60";
const isDirty = (k: OAuthFieldKey) => props.dirtyKeys.includes(k);
const err = (k: OAuthFieldKey) => props.errors[k] ?? null;
const isOidc = computed(() => form.value.id === "oidc");

/* ---------------- Status & completeness ---------------- */

const status = computed(() => oauthStatus(props.saved));
const statusBadge = computed(() => {
  switch (status.value) {
    case "active":
      return { tone: "success" as const, label: t("settings.oauth.status.active") };
    case "incomplete":
      return { tone: "warning" as const, label: t("settings.oauth.status.incomplete") };
    default:
      return { tone: "neutral" as const, label: t("settings.oauth.status.disabled") };
  }
});

const missing = computed(() => (form.value.enabled ? oauthMissing(form.value, props.saved) : []));
const missingText = computed(() =>
  missing.value.map((k) => t(`settings.oauth.fields.${k}`)).join(t("settings.oauth.listSeparator")),
);
/** Error first, then an amber edge on what an enabled provider still needs. */
function fieldClass(k: OAuthFieldKey): string {
  if (err(k)) return errorClass;
  return missing.value.includes(k) ? warnClass : "";
}

const title = computed(() => form.value.displayName.trim() || OAUTH_DEFAULT_NAMES[form.value.id]);
const consoleUrl = computed(() => OAUTH_CONSOLE_URLS[form.value.id] ?? null);

const CHIP: Record<OAuthProviderForm["id"], string> = {
  github: "bg-fg text-bg",
  google: "icon-chip-info",
  linuxdo: "icon-chip-warning",
  wechat: "icon-chip-success",
  dingtalk: "icon-chip-info",
  oidc: "icon-chip-accent",
};

/* ---------------- Client secret ---------------- */

const showSecret = ref(false);

function clearStoredSecret() {
  form.value.clientSecret = "";
  form.value.clearSecret = true;
  showSecret.value = false;
}

const secretHint = computed(() => {
  if (form.value.clearSecret) return t("settings.oauth.secretHintClear");
  if (form.value.clientSecret.trim() && props.saved.clientSecretSet) return t("settings.oauth.secretHintReplace");
  return props.saved.clientSecretSet ? t("settings.oauth.secretHintSet") : t("settings.oauth.secretHintUnset");
});
const secretPlaceholder = computed(() => {
  if (form.value.clearSecret) return t("settings.oauth.secretClearedPlaceholder");
  return props.saved.clientSecretSet ? t("settings.oauth.secretKeepPlaceholder") : t("settings.oauth.secretPlaceholder");
});

/* ---------------- Advanced ---------------- */

const advancedDirty = computed(() => OAUTH_ADVANCED_FIELDS.some(isDirty));
const advancedErrors = computed(() => OAUTH_ADVANCED_FIELDS.filter((k) => err(k)).length);
/** Something inside the disclosure needs a look (an error, or a missing required value). */
const advancedAttention = computed(
  () => advancedErrors.value > 0 || OAUTH_ADVANCED_FIELDS.some((k) => missing.value.includes(k)),
);
// The custom OIDC provider has no presets, so its endpoints start visible.
const advancedOpen = ref(isOidc.value || advancedAttention.value);
watch(advancedAttention, (needs) => {
  if (needs) advancedOpen.value = true;
});

const endpointsRequired = computed(() => form.value.enabled || isOidc.value);
const advancedSummary = computed(() => {
  const scopes = form.value.scopes.trim();
  return scopes ? t("settings.oauth.advancedSummary", { scopes }) : t("settings.oauth.advancedSummaryNoScopes");
});

const ENDPOINT_PLACEHOLDER: Record<(typeof OAUTH_ENDPOINTS)[number], string> = {
  authorizeUrl: "https://sso.example.com/oauth2/authorize",
  tokenUrl: "https://sso.example.com/oauth2/token",
  userinfoUrl: "https://sso.example.com/oauth2/userinfo",
};
const PATH_FIELDS = ["idField", "emailField", "nameField"] as const;
const PATH_PLACEHOLDER: Record<(typeof PATH_FIELDS)[number], string> = { idField: "sub", emailField: "email", nameField: "name" };

function selectAll(ev: FocusEvent) {
  (ev.target as HTMLInputElement | null)?.select();
}
</script>

<template>
  <UiCard>
    <template #header>
      <div class="flex min-w-0 items-center gap-3">
        <span
          class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-opacity duration-200"
          :class="[CHIP[form.id], form.enabled ? '' : 'opacity-60']"
        >
          <OAuthProviderMark :provider="form.id" :size="18" />
        </span>
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold text-fg">{{ title }}</h2>
          <p class="truncate text-2xs text-fg-subtle">{{ t(`settings.oauth.kinds.${form.id}`) }}</p>
        </div>
      </div>
    </template>
    <template #actions>
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="scale-95 opacity-0"
        leave-to-class="scale-95 opacity-0"
      >
        <UiBadge :key="status" :tone="statusBadge.tone" dot :pulse="status === 'active'">{{ statusBadge.label }}</UiBadge>
      </Transition>
    </template>

    <SettingSwitchRow
      v-model="form.enabled"
      :title="t('settings.oauth.enabled')"
      :description="t('settings.oauth.enabledHelp')"
      tone="success"
      :dirty="isDirty('enabled')"
    />

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      enter-from-class="-translate-y-1 opacity-0"
      leave-to-class="-translate-y-1 opacity-0"
    >
      <UiAlert v-if="missing.length" class="mt-4" tone="warning">
        {{ t("settings.oauth.missing", { fields: missingText }) }}
      </UiAlert>
    </Transition>

    <div class="mt-4 grid gap-4 border-t border-line/70 pt-5 sm:grid-cols-2">
      <SettingField
        :input-id="`${idp}-name`"
        :label="t('settings.oauth.fields.displayName')"
        :hint="t('settings.oauth.displayNameHint')"
        :dirty="isDirty('displayName')"
        :error="err('displayName')"
      >
        <input
          :id="`${idp}-name`"
          v-model="form.displayName"
          type="text"
          autocomplete="off"
          :maxlength="OAUTH_LIMITS.displayName"
          class="input"
          :class="fieldClass('displayName')"
          :placeholder="OAUTH_DEFAULT_NAMES[form.id]"
        />
      </SettingField>

      <SettingField
        :input-id="`${idp}-client-id`"
        :label="t('settings.oauth.fields.clientId')"
        :required="form.enabled"
        :dirty="isDirty('clientId')"
        :error="err('clientId')"
      >
        <input
          :id="`${idp}-client-id`"
          v-model="form.clientId"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :maxlength="OAUTH_LIMITS.clientId"
          class="input font-mono"
          :class="fieldClass('clientId')"
          :placeholder="t('settings.oauth.clientIdPlaceholder')"
        />
      </SettingField>

      <SettingField
        class="sm:col-span-2"
        :input-id="`${idp}-secret`"
        :label="t('settings.oauth.fields.clientSecret')"
        :hint="secretHint"
        :required="form.enabled"
        :dirty="isDirty('clientSecret')"
        :error="err('clientSecret')"
      >
        <template #aside>
          <Transition
            mode="out-in"
            enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            enter-from-class="scale-95 opacity-0"
            leave-to-class="scale-95 opacity-0"
          >
            <UiBadge v-if="form.clearSecret" key="clear" tone="danger" dot>{{ t("settings.oauth.secretClearing") }}</UiBadge>
            <UiBadge v-else-if="saved.clientSecretSet" key="set" tone="success" dot>{{ t("settings.oauth.secretSet") }}</UiBadge>
            <UiBadge v-else key="unset">{{ t("settings.oauth.secretUnset") }}</UiBadge>
          </Transition>
        </template>
        <div class="flex gap-2">
          <span class="relative block min-w-0 flex-1">
            <input
              :id="`${idp}-secret`"
              v-model="form.clientSecret"
              :type="showSecret ? 'text' : 'password'"
              :name="`${idp}-secret`"
              autocomplete="new-password"
              spellcheck="false"
              :maxlength="OAUTH_LIMITS.clientSecret"
              class="input pr-10 font-mono"
              :class="fieldClass('clientSecret')"
              :disabled="form.clearSecret"
              :placeholder="secretPlaceholder"
            />
            <button
              v-if="!form.clearSecret"
              type="button"
              class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
              :aria-label="showSecret ? t('settings.oauth.hideSecret') : t('settings.oauth.showSecret')"
              :aria-pressed="showSecret"
              @click="showSecret = !showSecret"
            >
              <UiIcon :name="showSecret ? 'eye-off' : 'eye'" :size="15" />
            </button>
          </span>
          <button v-if="form.clearSecret" type="button" class="btn btn-secondary shrink-0" @click="form.clearSecret = false">
            <UiIcon name="rotate-ccw" :size="14" />
            {{ t("settings.oauth.secretUndo") }}
          </button>
          <button
            v-else-if="saved.clientSecretSet"
            type="button"
            class="btn btn-ghost shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
            @click="clearStoredSecret"
          >
            <UiIcon name="trash" :size="14" />
            {{ t("settings.oauth.secretClear") }}
          </button>
        </div>
      </SettingField>

      <!-- Redirect URI to register at the provider -->
      <div class="min-w-0 sm:col-span-2">
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <label :for="`${idp}-callback`" class="truncate text-xs font-medium text-fg-muted">{{ t("settings.oauth.callback") }}</label>
          <a
            v-if="consoleUrl"
            :href="consoleUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            {{ t("settings.oauth.openConsole") }}
            <UiIcon name="external-link" :size="12" />
          </a>
        </div>
        <span class="relative block">
          <input
            :id="`${idp}-callback`"
            :value="callbackUrl"
            type="text"
            readonly
            spellcheck="false"
            class="input cursor-text bg-surface-2/60 pr-10 font-mono text-xs text-fg-muted dark:bg-surface-2/40"
            @focus="selectAll"
          />
          <CopyButton :text="callbackUrl" class="absolute right-1 top-1/2 -translate-y-1/2" />
        </span>
        <p class="hint flex items-start gap-1">
          <UiIcon name="info" :size="12" class="mt-0.5 shrink-0" />
          <span>{{ t("settings.oauth.callbackHint", { name: title }) }}</span>
        </p>
      </div>
    </div>

    <div class="mt-5 border-t border-line/70 pt-4">
      <SettingSwitchRow
        v-model="form.allowSignup"
        icon="user-plus"
        tone="accent"
        :title="t('settings.oauth.allowSignup')"
        :description="t('settings.oauth.allowSignupHelp')"
        :dirty="isDirty('allowSignup')"
      >
        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-0.5 opacity-0"
          leave-to-class="opacity-0"
        >
          <p v-if="form.allowSignup && !registrationOpen" class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-fg-subtle">
            <span class="inline-flex items-center gap-1">
              <UiIcon name="info" :size="11" />
              {{ t("settings.oauth.signupClosedNote") }}
            </span>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-0.5 font-medium text-accent hover:underline"
              @click="emit('open-registration')"
            >
              {{ t("settings.oauth.manageRegistration") }}
              <UiIcon name="arrow-right" :size="11" />
            </button>
          </p>
        </Transition>
      </SettingSwitchRow>
    </div>

    <!-- ============ Advanced: endpoints, scopes, userinfo field paths ============ -->
    <div class="mt-4 border-t border-line/70 pt-3">
      <button
        type="button"
        class="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :aria-expanded="advancedOpen"
        :aria-controls="`${idp}-advanced`"
        @click="advancedOpen = !advancedOpen"
      >
        <UiIcon name="sliders" :size="14" class="shrink-0 text-fg-subtle" />
        <span class="text-sm font-medium text-fg">
          {{ isOidc ? t("settings.oauth.advancedOidc") : t("settings.oauth.advanced") }}
        </span>
        <span v-if="advancedDirty" class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" :title="t('settings.modified')" />
        <UiBadge v-if="advancedErrors" tone="danger">{{ t("settings.oauth.advancedErrors", { n: advancedErrors }) }}</UiBadge>
        <span class="ml-auto flex min-w-0 items-center gap-2">
          <span class="hidden min-w-0 truncate font-mono text-2xs text-fg-subtle sm:block">{{ advancedSummary }}</span>
          <UiIcon
            name="chevron-down"
            :size="14"
            class="shrink-0 text-fg-subtle transition-transform duration-200 motion-reduce:transition-none"
            :class="advancedOpen ? 'rotate-180' : ''"
          />
        </span>
      </button>

      <!-- grid-rows trick animates the height; instant under reduced motion -->
      <div
        :id="`${idp}-advanced`"
        class="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        :class="advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      >
        <div class="min-h-0 overflow-hidden">
          <div class="grid gap-4 pb-1 pt-3" :inert="!advancedOpen">
            <p class="text-xs leading-relaxed text-fg-subtle">
              {{ isOidc ? t("settings.oauth.oidcHelp") : t("settings.oauth.presetHelp") }}
            </p>
            <SettingField
              v-for="k in OAUTH_ENDPOINTS"
              :key="k"
              :input-id="`${idp}-${k}`"
              :label="t(`settings.oauth.fields.${k}`)"
              :required="endpointsRequired"
              :dirty="isDirty(k)"
              :error="err(k)"
            >
              <input
                :id="`${idp}-${k}`"
                v-model="form[k]"
                type="text"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                :maxlength="OAUTH_LIMITS[k]"
                class="input font-mono text-xs"
                :class="fieldClass(k)"
                :placeholder="ENDPOINT_PLACEHOLDER[k]"
              />
            </SettingField>
            <SettingField
              :input-id="`${idp}-scopes`"
              :label="t('settings.oauth.fields.scopes')"
              :hint="t('settings.oauth.scopesHint')"
              :dirty="isDirty('scopes')"
              :error="err('scopes')"
            >
              <input
                :id="`${idp}-scopes`"
                v-model="form.scopes"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :maxlength="OAUTH_LIMITS.scopes"
                class="input font-mono text-xs"
                :class="fieldClass('scopes')"
                placeholder="openid email profile"
              />
            </SettingField>
            <div class="grid gap-4 sm:grid-cols-3">
              <SettingField
                v-for="k in PATH_FIELDS"
                :key="k"
                :input-id="`${idp}-${k}`"
                :label="t(`settings.oauth.fields.${k}`)"
                :required="k === 'idField' && endpointsRequired"
                :dirty="isDirty(k)"
                :error="err(k)"
              >
                <input
                  :id="`${idp}-${k}`"
                  v-model="form[k]"
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  :maxlength="OAUTH_LIMITS[k]"
                  class="input font-mono text-xs"
                  :class="fieldClass(k)"
                  :placeholder="PATH_PLACEHOLDER[k]"
                />
              </SettingField>
            </div>
            <p class="-mt-2 text-xs text-fg-subtle">{{ t("settings.oauth.pathHint") }}</p>
          </div>
        </div>
      </div>
    </div>
  </UiCard>
</template>
