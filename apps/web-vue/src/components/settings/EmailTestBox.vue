<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { TestEmailRequest } from "@slipgate/contracts";
import { apiJson, errorText } from "../../lib/api";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import { MAILBOX_RE } from "./emailForm";

/** Sends a test message with the saved SMTP settings and shows the outcome (or the SMTP error). */
const props = defineProps<{
  /** Why a test can't run right now (unsaved edits, mail not configured); null when it can. */
  blockedReason?: string | null;
  defaultTo?: string;
}>();

const { t } = useI18n();

type Result = { ok: true; to: string } | { ok: false; message: string };

const to = ref(props.defaultTo ?? "");
const sending = ref(false);
const result = ref<Result | null>(null);
const touched = ref(false);

const address = computed(() => to.value.trim());
const valid = computed(() => MAILBOX_RE.test(address.value));
const toError = computed(() => (touched.value && address.value && !valid.value ? t("settings.email.test.invalidTo") : null));
const canSend = computed(() => valid.value && !props.blockedReason && !sending.value);

async function send() {
  touched.value = true;
  if (!canSend.value) return;
  sending.value = true;
  result.value = null;
  const target = address.value;
  try {
    const body: TestEmailRequest = { to: target };
    await apiJson<{ sent: boolean }>("/api/v1/admin/email/test", { method: "POST", body });
    result.value = { ok: true, to: target };
  } catch (err) {
    result.value = { ok: false, message: errorText(err, t("settings.email.test.failed")) };
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div>
    <p class="text-xs leading-relaxed text-fg-subtle">{{ t("settings.email.test.help") }}</p>

    <form class="mt-4" novalidate @submit.prevent="send">
      <label for="smtp-test-to" class="label">{{ t("settings.email.test.to") }}</label>
      <div class="flex flex-col gap-2 sm:flex-row">
        <span class="relative block min-w-0 flex-1">
          <UiIcon name="mail" :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            id="smtp-test-to"
            v-model="to"
            type="email"
            inputmode="email"
            autocomplete="off"
            spellcheck="false"
            maxlength="254"
            class="input pl-9"
            :class="toError ? '!border-danger/60 focus:!ring-danger/20' : ''"
            :aria-invalid="Boolean(toError)"
            placeholder="admin@example.com"
            @blur="touched = true"
          />
        </span>
        <button type="submit" class="btn btn-secondary shrink-0" :disabled="!canSend" :aria-busy="sending">
          <UiIcon :name="sending ? 'loader' : 'mail'" :size="15" :spin="sending" />
          {{ sending ? t("settings.email.test.sending") : t("settings.email.test.send") }}
        </button>
      </div>
      <p v-if="toError" class="mt-1 flex animate-fade-in items-center gap-1 text-xs text-danger" role="alert">
        <UiIcon name="alert" :size="12" />
        {{ toError }}
      </p>
      <p v-else-if="blockedReason" class="mt-2 flex items-start gap-1.5 text-xs text-warning">
        <UiIcon name="info" :size="13" class="mt-px" />
        <span class="min-w-0">{{ blockedReason }}</span>
      </p>
    </form>

    <div aria-live="polite">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="result?.ok" key="ok" class="mt-4" tone="success" :title="t('settings.email.test.sentTitle')">
          {{ t("settings.email.test.sentBody", { to: result.to }) }}
        </UiAlert>
        <UiAlert v-else-if="result" key="fail" class="mt-4" tone="danger" :title="t('settings.email.test.failedTitle')">
          <p
            class="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-surface-2/70 px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg"
          >{{ result.message }}</p>
          <p class="mt-2 text-xs">{{ t("settings.email.test.failedHint") }}</p>
        </UiAlert>
      </Transition>
    </div>
  </div>
</template>
