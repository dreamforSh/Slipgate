<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { errorText } from "../../lib/api";
import { formatDateTime, formatRelative } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";

/**
 * Profile card for console sessions: this device's session, "sign out other devices" (keeps this
 * one on a fresh token) and "sign out of all devices" (asks first, then returns to sign-in). Both
 * bump the account's token version server-side, so every older token stops working at once.
 */
const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const router = useRouter();

const busy = ref<"others" | "all" | null>(null);
const confirming = ref(false);
const cancelBtn = ref<HTMLButtonElement | null>(null);
const allBtn = ref<HTMLButtonElement | null>(null);

/* ---------------- This device ---------------- */

function detectBrowser(ua: string): string | null {
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return null;
}

function detectOs(ua: string): string | null {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
const deviceLabel = computed(() =>
  t("profile.sessions.device", {
    browser: detectBrowser(ua) ?? t("profile.sessions.unknownBrowser"),
    os: detectOs(ua) ?? t("profile.sessions.unknownOs"),
  }),
);

/** Re-evaluated every minute so "signed in 3 minutes ago" stays true while the page is open. */
const now = ref(Date.now());
const ticker = window.setInterval(() => (now.value = Date.now()), 60_000);
onBeforeUnmount(() => window.clearInterval(ticker));

const signedIn = computed(() => {
  const at = auth.sessionTimes.issuedAtIso;
  return at ? t("profile.sessions.signedIn", { time: formatRelative(at, now.value) }) : "";
});
const expires = computed(() => {
  const at = auth.sessionTimes.expiresAtIso;
  return at ? t("profile.sessions.expires", { date: formatDateTime(at) }) : "";
});

/* ---------------- Actions ---------------- */

async function signOutOthers() {
  if (busy.value) return;
  busy.value = "others";
  try {
    await auth.revokeAllSessions(true);
    toast.success(t("profile.sessions.othersDone"));
  } catch (err) {
    toast.error(errorText(err, t("profile.sessions.failed")));
  } finally {
    busy.value = null;
  }
}

async function openConfirm() {
  confirming.value = true;
  await nextTick();
  // The safe choice gets focus: Enter on an accidental open must not sign everything out.
  cancelBtn.value?.focus();
}

async function closeConfirm() {
  confirming.value = false;
  await nextTick();
  allBtn.value?.focus();
}

async function signOutEverywhere() {
  if (busy.value) return;
  busy.value = "all";
  try {
    await auth.revokeAllSessions(false);
    toast.success(t("profile.sessions.allDone"));
    await router.push("/login");
  } catch (err) {
    toast.error(errorText(err, t("profile.sessions.failed")));
    busy.value = null;
  }
}
</script>

<template>
  <UiCard icon="log-in" :title="t('profile.sessions.title')">
    <template #actions>
      <UiBadge tone="success" dot>{{ t("profile.sessions.active") }}</UiBadge>
    </template>

    <!-- This device -->
    <div class="flex items-center gap-3 rounded-lg border border-line/80 bg-surface-2/40 px-3.5 py-3">
      <span class="icon-chip icon-chip-accent h-10 w-10 rounded-xl" aria-hidden="true">
        <UiIcon name="monitor" :size="18" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="truncate text-sm font-medium text-fg">{{ deviceLabel }}</span>
          <UiBadge tone="accent">{{ t("profile.sessions.current") }}</UiBadge>
        </p>
        <p v-if="signedIn || expires" class="mt-0.5 truncate text-xs text-fg-subtle">
          <span v-if="signedIn">{{ signedIn }}</span>
          <span v-if="signedIn && expires" aria-hidden="true"> · </span>
          <span v-if="expires">{{ expires }}</span>
        </p>
      </div>
    </div>

    <p class="mt-4 text-xs leading-relaxed text-fg-subtle">{{ t("profile.sessions.desc") }}</p>

    <ul class="mt-4 divide-y divide-line/70 overflow-hidden rounded-lg border border-line/80">
      <!-- Sign out other devices -->
      <li class="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-center">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-fg">{{ t("profile.sessions.othersTitle") }}</p>
          <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ t("profile.sessions.othersDesc") }}</p>
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm shrink-0"
          :disabled="busy !== null"
          :aria-busy="busy === 'others'"
          @click="signOutOthers"
        >
          <UiIcon :name="busy === 'others' ? 'loader' : 'logout'" :size="13" :spin="busy === 'others'" />
          {{ busy === "others" ? t("common.submitting") : t("profile.sessions.othersAction") }}
        </button>
      </li>

      <!-- Sign out of all devices (asks first) -->
      <li class="px-3.5 py-3">
        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0 motion-reduce:translate-y-0"
          leave-to-class="opacity-0"
        >
          <div v-if="!confirming" key="offer" class="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-fg">{{ t("profile.sessions.allTitle") }}</p>
              <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ t("profile.sessions.allDesc") }}</p>
            </div>
            <button
              ref="allBtn"
              type="button"
              class="btn btn-danger btn-sm shrink-0"
              :disabled="busy !== null"
              aria-haspopup="true"
              @click="openConfirm"
            >
              <UiIcon name="shield-alert" :size="13" />
              {{ t("profile.sessions.allAction") }}
            </button>
          </div>

          <div
            v-else
            key="confirm"
            role="alertdialog"
            aria-labelledby="sessions-confirm-title"
            aria-describedby="sessions-confirm-desc"
            class="rounded-lg border border-danger/30 bg-danger/[0.06] p-3.5"
            @keydown.esc.stop="closeConfirm"
          >
            <p id="sessions-confirm-title" class="flex items-center gap-2 text-sm font-medium text-fg">
              <UiIcon name="alert" :size="14" class="shrink-0 text-danger" />
              {{ t("profile.sessions.confirmTitle") }}
            </p>
            <p id="sessions-confirm-desc" class="mt-1 text-xs leading-relaxed text-fg-muted">
              {{ t("profile.sessions.confirmDesc") }}
            </p>
            <div class="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button ref="cancelBtn" type="button" class="btn btn-ghost btn-sm" :disabled="busy !== null" @click="closeConfirm">
                {{ t("common.cancel") }}
              </button>
              <button
                type="button"
                class="btn btn-danger-solid btn-sm"
                :disabled="busy !== null"
                :aria-busy="busy === 'all'"
                @click="signOutEverywhere"
              >
                <UiIcon :name="busy === 'all' ? 'loader' : 'logout'" :size="13" :spin="busy === 'all'" />
                {{ busy === "all" ? t("common.submitting") : t("profile.sessions.confirmAction") }}
              </button>
            </div>
          </div>
        </Transition>
      </li>
    </ul>
  </UiCard>
</template>
