<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { EmailConfig, SmtpSecurityMode } from "@slipgate/contracts";
import { useAuthStore } from "../../stores/auth";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import EmailTestBox from "./EmailTestBox.vue";
import SettingField from "./SettingField.vue";
import SettingSwitchRow from "./SettingSwitchRow.vue";
import { DEFAULT_PORTS, SECURITY_MODES, emailStatus, type EmailFieldKey, type EmailForm } from "./emailForm";

/**
 * "Email (SMTP)" settings tab: server, credentials, sender and TLS options, plus a test sender.
 * Edits stay in the parent's form so the page's sticky save bar saves them with everything else.
 */
const form = defineModel<EmailForm>({ required: true });
const props = defineProps<{
  /** Configuration as saved on the server (what mail is actually sent with). */
  saved: EmailConfig;
  dirtyKeys: EmailFieldKey[];
  errors: Partial<Record<EmailFieldKey, string>>;
  /** Portal switch "verify email on sign-up" as currently edited. */
  verificationRequired: boolean;
  /** Whether Settings → API base URL (as currently edited) is an absolute URL: reset links are built only from it. */
  publicUrlSet: boolean;
}>();
const emit = defineEmits<{ (e: "open-registration"): void; (e: "open-general"): void }>();

const { t } = useI18n();
const auth = useAuthStore();

const errorClass = "!border-danger/60 focus:!ring-danger/20";
const isDirty = (k: EmailFieldKey) => props.dirtyKeys.includes(k);
const err = (k: EmailFieldKey) => props.errors[k] ?? null;

/* ---------------- Status ---------------- */

const status = computed(() => emailStatus(props.saved));
const ready = computed(() => status.value === "ready");
const statusBadge = computed(() => {
  switch (status.value) {
    case "ready":
      return { tone: "success" as const, label: t("settings.email.status.ready") };
    case "incomplete":
      return { tone: "warning" as const, label: t("settings.email.status.incomplete") };
    default:
      return { tone: "neutral" as const, label: t("settings.email.status.disabled") };
  }
});

/* ---------------- Security & port ---------------- */

const securityOptions = computed(() =>
  SECURITY_MODES.map((value) => ({ value, label: t(`settings.email.securityOptions.${value}`) })),
);
const KNOWN_PORTS = new Set(Object.values(DEFAULT_PORTS));

/** Switching modes moves a default (or empty) port along; a custom port is left alone. */
function setSecurity(next: SmtpSecurityMode) {
  const f = form.value;
  const followDefault = f.port === "" || KNOWN_PORTS.has(Number(f.port));
  f.security = next;
  if (followDefault) f.port = DEFAULT_PORTS[next];
}

const suggestedPort = computed(() => DEFAULT_PORTS[form.value.security]);
/** e.g. SSL/TLS on 587: almost always a mix-up, so offer the matching default. */
const portMismatch = computed(() => {
  const p = form.value.port;
  return p !== "" && KNOWN_PORTS.has(Number(p)) && Number(p) !== suggestedPort.value;
});

/* ---------------- Password ---------------- */

const showPassword = ref(false);

function clearStoredPassword() {
  form.value.password = "";
  form.value.clearPassword = true;
  showPassword.value = false;
}

const passwordHint = computed(() => {
  if (form.value.clearPassword) return t("settings.email.passwordHintClear");
  if (form.value.password && props.saved.passwordSet) return t("settings.email.passwordHintReplace");
  return props.saved.passwordSet ? t("settings.email.passwordHintSet") : t("settings.email.passwordHintUnset");
});
const passwordPlaceholder = computed(() => {
  if (form.value.clearPassword) return t("settings.email.passwordClearedPlaceholder");
  return props.saved.passwordSet ? t("settings.email.passwordKeepPlaceholder") : t("settings.email.passwordPlaceholder");
});

/* ---------------- Test & usage ---------------- */

const unsaved = computed(() => props.dirtyKeys.length > 0);
const testBlocked = computed(() => {
  if (unsaved.value) return t("settings.email.test.unsaved");
  if (!ready.value) return t("settings.email.test.notReady");
  return null;
});

const verifyBadge = computed(() => {
  if (!props.verificationRequired) return { tone: "neutral" as const, label: t("settings.email.usage.off") };
  return ready.value
    ? { tone: "success" as const, label: t("settings.email.usage.active") }
    : { tone: "warning" as const, label: t("settings.email.usage.waiting") };
});

/** Password reset needs working mail and the site's absolute public URL to point its links at. */
const resetBadge = computed(() => {
  if (!ready.value) return { tone: "neutral" as const, label: t("settings.email.usage.unavailable") };
  return props.publicUrlSet
    ? { tone: "success" as const, label: t("settings.email.usage.available") }
    : { tone: "warning" as const, label: t("settings.email.usage.needsPublicUrl") };
});

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 5) * 60}ms`, animationFillMode: "both" });
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-5">
    <div class="min-w-0 space-y-6 xl:col-span-3">
      <!-- ============ Server & credentials ============ -->
      <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(0)" icon="server" :title="t('settings.email.serverTitle')">
        <template #actions>
          <Transition
            mode="out-in"
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            enter-from-class="scale-95 opacity-0"
            leave-to-class="scale-95 opacity-0"
          >
            <UiBadge :key="status" :tone="statusBadge.tone" dot :pulse="ready">{{ statusBadge.label }}</UiBadge>
          </Transition>
        </template>

        <SettingSwitchRow
          v-model="form.enabled"
          icon="mail"
          tone="success"
          :title="t('settings.email.enabled')"
          :description="t('settings.email.enabledHelp')"
          :dirty="isDirty('enabled')"
        />

        <div class="mt-1 grid gap-4 border-t border-line/70 pt-5 sm:grid-cols-6">
          <SettingField
            class="sm:col-span-4"
            input-id="smtp-host"
            :label="t('settings.email.host')"
            :required="form.enabled"
            :dirty="isDirty('host')"
            :error="err('host')"
          >
            <input
              id="smtp-host"
              v-model="form.host"
              type="text"
              inputmode="url"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              maxlength="255"
              class="input font-mono"
              :class="err('host') ? errorClass : ''"
              :placeholder="t('settings.email.hostPlaceholder')"
            />
          </SettingField>
          <SettingField
            class="sm:col-span-2"
            input-id="smtp-port"
            :label="t('settings.email.port')"
            required
            :dirty="isDirty('port')"
            :error="err('port')"
          >
            <input
              id="smtp-port"
              v-model.number="form.port"
              type="number"
              min="1"
              max="65535"
              step="1"
              class="input font-mono"
              :class="err('port') ? errorClass : ''"
              :placeholder="String(suggestedPort)"
            />
          </SettingField>

          <SettingField class="sm:col-span-6" :label="t('settings.email.security')" :dirty="isDirty('security')">
            <SegmentedControl
              :model-value="form.security"
              :options="securityOptions"
              block
              size="md"
              :aria-label="t('settings.email.security')"
              @update:model-value="setSecurity"
            />
            <div class="mt-1.5 flex min-h-[1.25rem] flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <Transition
                mode="out-in"
                enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
                leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
                enter-from-class="opacity-0"
                leave-to-class="opacity-0"
              >
                <p :key="form.security" class="text-xs text-fg-subtle">{{ t(`settings.email.securityHelp.${form.security}`) }}</p>
              </Transition>
              <Transition
                enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
                enter-from-class="translate-y-0.5 opacity-0"
                leave-to-class="opacity-0"
              >
                <span v-if="portMismatch" class="inline-flex items-center gap-2 text-xs text-warning">
                  <UiIcon name="alert" :size="12" />
                  {{ t("settings.email.portSuggest", { mode: t(`settings.email.securityOptions.${form.security}`), port: suggestedPort }) }}
                  <button type="button" class="btn btn-xs btn-secondary" @click="form.port = suggestedPort">
                    {{ t("settings.email.usePort", { port: suggestedPort }) }}
                  </button>
                </span>
              </Transition>
            </div>
          </SettingField>

          <SettingField
            class="sm:col-span-3"
            input-id="smtp-username"
            :label="t('settings.email.username')"
            :dirty="isDirty('username')"
            :error="err('username')"
          >
            <input
              id="smtp-username"
              v-model="form.username"
              type="text"
              name="smtp-username"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              maxlength="255"
              class="input font-mono"
              :class="err('username') ? errorClass : ''"
              :placeholder="t('settings.email.usernamePlaceholder')"
            />
          </SettingField>

          <SettingField
            class="sm:col-span-3"
            input-id="smtp-password"
            :label="t('settings.email.password')"
            :hint="passwordHint"
            :dirty="isDirty('password')"
            :error="err('password')"
          >
            <template #aside>
              <Transition
                mode="out-in"
                enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
                leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
                enter-from-class="scale-95 opacity-0"
                leave-to-class="scale-95 opacity-0"
              >
                <UiBadge v-if="form.clearPassword" key="clear" tone="danger" dot>{{ t("settings.email.passwordClearing") }}</UiBadge>
                <UiBadge v-else-if="saved.passwordSet" key="set" tone="success" dot>{{ t("settings.email.passwordSet") }}</UiBadge>
                <UiBadge v-else key="unset">{{ t("settings.email.passwordUnset") }}</UiBadge>
              </Transition>
            </template>
            <div class="flex gap-2">
              <span class="relative block min-w-0 flex-1">
                <input
                  id="smtp-password"
                  v-model="form.password"
                  :type="showPassword ? 'text' : 'password'"
                  name="smtp-password"
                  autocomplete="new-password"
                  spellcheck="false"
                  maxlength="512"
                  class="input pr-10"
                  :class="err('password') ? errorClass : ''"
                  :disabled="form.clearPassword"
                  :placeholder="passwordPlaceholder"
                />
                <button
                  v-if="!form.clearPassword"
                  type="button"
                  class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
                  :aria-label="showPassword ? t('settings.email.hidePassword') : t('settings.email.showPassword')"
                  :aria-pressed="showPassword"
                  @click="showPassword = !showPassword"
                >
                  <UiIcon :name="showPassword ? 'eye-off' : 'eye'" :size="15" />
                </button>
              </span>
              <button
                v-if="form.clearPassword"
                type="button"
                class="btn btn-secondary shrink-0"
                @click="form.clearPassword = false"
              >
                <UiIcon name="rotate-ccw" :size="14" />
                {{ t("settings.email.passwordUndo") }}
              </button>
              <button
                v-else-if="saved.passwordSet"
                type="button"
                class="btn btn-ghost shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                @click="clearStoredPassword"
              >
                <UiIcon name="trash" :size="14" />
                {{ t("settings.email.passwordClear") }}
              </button>
            </div>
          </SettingField>
        </div>
      </UiCard>

      <!-- ============ Sender & TLS ============ -->
      <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(1)" icon="mail" :title="t('settings.email.senderTitle')">
        <div class="grid gap-4 sm:grid-cols-2">
          <SettingField
            input-id="smtp-from"
            :label="t('settings.email.fromAddress')"
            :hint="t('settings.email.fromAddressHint')"
            :required="form.enabled"
            :dirty="isDirty('fromAddress')"
            :error="err('fromAddress')"
          >
            <input
              id="smtp-from"
              v-model="form.fromAddress"
              type="email"
              inputmode="email"
              autocomplete="off"
              spellcheck="false"
              maxlength="255"
              class="input font-mono"
              :class="err('fromAddress') ? errorClass : ''"
              :placeholder="t('settings.email.fromAddressPlaceholder')"
            />
          </SettingField>
          <SettingField
            input-id="smtp-from-name"
            :label="t('settings.email.fromName')"
            :hint="t('settings.email.fromNameHint')"
            :dirty="isDirty('fromName')"
            :error="err('fromName')"
          >
            <input
              id="smtp-from-name"
              v-model="form.fromName"
              type="text"
              autocomplete="off"
              maxlength="64"
              class="input"
              :class="err('fromName') ? errorClass : ''"
              :placeholder="t('settings.email.fromNamePlaceholder')"
            />
          </SettingField>
        </div>

        <div class="mt-5 border-t border-line/70 pt-5">
          <div>
            <SettingSwitchRow
              v-model="form.allowInsecureTls"
              icon="shield-alert"
              tone="warning"
              :title="t('settings.email.insecure')"
              :description="t('settings.email.insecureHelp')"
              :dirty="isDirty('allowInsecureTls')"
            >
              <p v-if="form.allowInsecureTls && form.security === 'none'" class="mt-1.5 flex items-center gap-1 text-2xs text-fg-subtle">
                <UiIcon name="info" :size="11" />
                {{ t("settings.email.insecureNoEffect") }}
              </p>
            </SettingSwitchRow>
          </div>
          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
            leave-to-class="-translate-y-1 opacity-0"
          >
            <UiAlert v-if="form.allowInsecureTls && form.security !== 'none'" class="mt-3" tone="warning">
              {{ t("settings.email.insecureWarning") }}
            </UiAlert>
          </Transition>
        </div>
      </UiCard>
    </div>

    <div class="min-w-0 space-y-6 xl:col-span-2">
      <!-- ============ Test ============ -->
      <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(2)" icon="zap" :title="t('settings.email.test.title')">
        <EmailTestBox :blocked-reason="testBlocked" :default-to="auth.user?.email ?? ''" />
      </UiCard>

      <!-- ============ What mail is used for ============ -->
      <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(3)" icon="info" :title="t('settings.email.usage.title')">
        <ul class="divide-y divide-line/70">
          <li class="flex items-start gap-3 pb-4">
            <span class="icon-chip icon-chip-violet mt-0.5 h-8 w-8"><UiIcon name="badge-check" :size="15" /></span>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                {{ t("settings.email.usage.verify") }}
                <UiBadge :tone="verifyBadge.tone" dot>{{ verifyBadge.label }}</UiBadge>
              </p>
              <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ t("settings.email.usage.verifyHelp") }}</p>
              <button
                type="button"
                class="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-accent hover:underline"
                @click="emit('open-registration')"
              >
                {{ t("settings.email.usage.manage") }}
                <UiIcon name="arrow-right" :size="12" />
              </button>
            </div>
          </li>
          <li class="flex items-start gap-3 pt-4">
            <span class="icon-chip icon-chip-info mt-0.5 h-8 w-8"><UiIcon name="key" :size="15" /></span>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                {{ t("settings.email.usage.reset") }}
                <UiBadge :tone="resetBadge.tone" dot>{{ resetBadge.label }}</UiBadge>
              </p>
              <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ t("settings.email.usage.resetHelp") }}</p>
              <button
                v-if="!publicUrlSet"
                type="button"
                class="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-accent hover:underline"
                @click="emit('open-general')"
              >
                {{ t("settings.email.usage.setPublicUrl") }}
                <UiIcon name="arrow-right" :size="12" />
              </button>
            </div>
          </li>
        </ul>
      </UiCard>
    </div>
  </div>
</template>
