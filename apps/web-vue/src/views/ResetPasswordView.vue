<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { ResetPasswordRequest } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon, { type IconName } from "../components/ui/UiIcon.vue";
import { ApiError, publicJson } from "../lib/api";
import { usePortalStore } from "../stores/portal";

/** Same shape the BFF accepts; anything else can't be a link we sent. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const portal = usePortalStore();

type Stage = "form" | "success" | "invalid" | "missing";

function readToken(): string {
  const raw = route.query.token;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v.trim() : "";
}

function stageFor(token: string): Stage {
  if (!token) return "missing";
  return TOKEN_RE.test(token) ? "form" : "invalid";
}

let token = readToken();
const stage = ref<Stage>(stageFor(token));

// A different link opened in the same tab reuses this view.
watch(
  () => route.query.token,
  () => {
    if (stage.value === "success") return;
    token = readToken();
    stage.value = stageFor(token);
    resetFields();
  },
);

const password = ref("");
const confirm = ref("");
const showPassword = ref(false);
const confirmTouched = ref(false);
const attempted = ref(false);
const submitting = ref(false);
const errorMessage = ref<string | null>(null);

function resetFields() {
  password.value = "";
  confirm.value = "";
  showPassword.value = false;
  confirmTouched.value = false;
  attempted.value = false;
  errorMessage.value = null;
}

/* ---------------- Strength ---------------- */

type Level = 0 | 1 | 2 | 3 | 4;

/** Rough, offline estimate: length plus character variety, with obvious patterns capped. */
function strengthOf(pw: string): Level {
  if (!pw) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  let score = 0;
  if (pw.length >= MIN_LENGTH) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  if (pw.length < MIN_LENGTH || /^(.)\1+$/.test(pw) || /^(?:0?123456789?|password|qwerty|abc123)/i.test(pw)) {
    score = Math.min(score, 1);
  }
  return Math.max(1, Math.min(4, score)) as Level;
}

const level = computed(() => strengthOf(password.value));
const LEVELS: Record<Exclude<Level, 0>, { key: string; bar: string; text: string }> = {
  1: { key: "weak", bar: "bg-danger", text: "text-danger" },
  2: { key: "fair", bar: "bg-warning", text: "text-warning" },
  3: { key: "good", bar: "bg-info", text: "text-info" },
  4: { key: "strong", bar: "bg-success", text: "text-success" },
};
const levelMeta = computed(() => (level.value ? LEVELS[level.value as Exclude<Level, 0>] : null));

/* ---------------- Validation ---------------- */

const tooShort = computed(() => password.value.length < MIN_LENGTH);
const mismatch = computed(() => confirm.value.length > 0 && confirm.value !== password.value);
const showMismatch = computed(() => mismatch.value && (confirmTouched.value || attempted.value || confirm.value.length >= password.value.length));
const confirmError = computed(() => {
  if (showMismatch.value) return t("register.reset.mismatch");
  if (attempted.value && !confirm.value) return t("register.reset.mismatch");
  return null;
});
const matches = computed(() => !tooShort.value && confirm.value.length > 0 && confirm.value === password.value);

/* ---------------- Submit ---------------- */

async function submit() {
  if (submitting.value) return;
  attempted.value = true;
  errorMessage.value = null;
  if (tooShort.value || password.value !== confirm.value) return;
  submitting.value = true;
  try {
    const body: ResetPasswordRequest = { token, password: password.value };
    await publicJson<{ reset: boolean }>("/api/v1/auth/reset-password", { method: "POST", body });
    resetFields();
    stage.value = "success";
    // The token is spent; keep it out of the address bar and history.
    void router.replace({ query: {} });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      resetFields();
      stage.value = "invalid";
    } else if (err instanceof ApiError && err.code === "backend_mode") {
      // Backend (admin-only) mode: only an administrator's link still works.
      errorMessage.value = t("authGuards.errors.backend_mode");
    } else if (err instanceof ApiError && err.status === 403) {
      errorMessage.value = t("register.reset.errors.rateLimited");
    } else if (err instanceof ApiError) {
      errorMessage.value = t("register.reset.errors.failed");
    } else {
      errorMessage.value = t("common.networkError");
    }
  } finally {
    submitting.value = false;
  }
}

/* ---------------- Dead-end states ---------------- */

const deadEnd = computed<{ icon: IconName; tone: string; title: string; body: string } | null>(() => {
  if (stage.value === "invalid") {
    return {
      icon: "unlink",
      tone: "icon-chip-danger",
      title: t("register.reset.invalidTitle"),
      body: t("register.reset.invalidBody"),
    };
  }
  if (stage.value === "missing") {
    return {
      icon: "link",
      tone: "icon-chip-warning",
      title: t("register.reset.missingTitle"),
      body: t("register.reset.missingBody"),
    };
  }
  return null;
});

onMounted(() => void portal.load());

const fade = {
  enterActiveClass: "transition duration-200 ease-out motion-reduce:transition-none",
  leaveActiveClass: "transition duration-150 ease-in motion-reduce:transition-none",
  enterFromClass: "translate-y-1.5 opacity-0",
  leaveToClass: "-translate-y-1 opacity-0",
};
</script>

<template>
  <AuthLayout :site-name="portal.settings?.siteName">
    <Transition mode="out-in" v-bind="fade">
      <!-- ============ Done ============ -->
      <div v-if="stage === 'success'" key="success" class="text-center" role="status">
        <span class="done-mark icon-chip icon-chip-success mx-auto h-14 w-14 rounded-2xl" aria-hidden="true">
          <UiIcon name="check-circle" :size="26" />
        </span>
        <h1 class="mt-5 text-xl font-semibold tracking-tight text-fg">{{ t("register.reset.successTitle") }}</h1>
        <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("register.reset.successBody") }}</p>
        <RouterLink to="/login" class="btn btn-primary mt-6 h-10 w-full">
          <UiIcon name="log-in" :size="16" />
          {{ t("register.reset.goLogin") }}
        </RouterLink>
      </div>

      <!-- ============ Invalid / expired / missing token ============ -->
      <div v-else-if="deadEnd" :key="stage" class="text-center" role="alert">
        <span class="icon-chip mx-auto h-12 w-12 rounded-2xl" :class="deadEnd.tone" aria-hidden="true">
          <UiIcon :name="deadEnd.icon" :size="22" />
        </span>
        <h1 class="mt-4 text-xl font-semibold tracking-tight text-fg">{{ deadEnd.title }}</h1>
        <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ deadEnd.body }}</p>
        <RouterLink to="/forgot-password" class="btn btn-primary mt-6 h-10 w-full">
          <UiIcon name="mail" :size="16" />
          {{ t("register.reset.requestNew") }}
        </RouterLink>
        <RouterLink to="/login" class="btn btn-ghost mt-2 h-10 w-full">
          <UiIcon name="chevron-left" :size="16" />
          {{ t("register.backToLogin") }}
        </RouterLink>
      </div>

      <!-- ============ New password form ============ -->
      <div v-else key="form">
        <h1 class="text-center text-xl font-semibold tracking-tight text-fg">{{ t("register.reset.title") }}</h1>
        <p class="mt-2 text-center text-sm leading-relaxed text-fg-muted">{{ t("register.reset.subtitle") }}</p>

        <form class="mt-6 space-y-4" novalidate @submit.prevent="submit">
          <!-- Lets password managers pair the new password with an account. -->
          <input type="text" name="username" autocomplete="username" class="sr-only" tabindex="-1" aria-hidden="true" />

          <div>
            <label for="reset-password" class="label">{{ t("register.reset.newPassword") }}</label>
            <span class="relative block">
              <input
                id="reset-password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                name="new-password"
                autocomplete="new-password"
                required
                :minlength="MIN_LENGTH"
                :maxlength="MAX_LENGTH"
                :placeholder="t('register.reset.newPasswordPlaceholder')"
                class="input h-10 pr-10"
                :class="attempted && tooShort ? '!border-danger/60 focus:!ring-danger/20' : ''"
                :aria-invalid="attempted && tooShort"
                aria-describedby="reset-strength"
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
                :aria-label="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <UiIcon :name="showPassword ? 'eye-off' : 'eye'" :size="16" />
              </button>
            </span>

            <!-- Strength meter -->
            <div id="reset-strength" class="mt-2" aria-live="polite">
              <div class="flex gap-1" aria-hidden="true">
                <span
                  v-for="i in 4"
                  :key="i"
                  class="h-1 flex-1 rounded-full transition-colors duration-300"
                  :class="levelMeta && i <= level ? levelMeta.bar : 'bg-surface-3'"
                />
              </div>
              <div class="mt-1.5 flex items-start justify-between gap-3 text-xs">
                <p v-if="attempted && tooShort" class="flex items-center gap-1 text-danger" role="alert">
                  <UiIcon name="alert" :size="12" />
                  {{ t("register.reset.tooShort") }}
                </p>
                <p v-else class="text-fg-subtle">{{ t("register.reset.strengthHint") }}</p>
                <span v-if="levelMeta" class="shrink-0 font-medium" :class="levelMeta.text">
                  <span class="sr-only">{{ t("register.reset.strength.label") }}:</span>
                  {{ t(`register.reset.strength.${levelMeta.key}`) }}
                </span>
              </div>
            </div>
          </div>

          <div>
            <label for="reset-confirm" class="label">{{ t("register.reset.confirm") }}</label>
            <span class="relative block">
              <input
                id="reset-confirm"
                v-model="confirm"
                :type="showPassword ? 'text' : 'password'"
                name="confirm-password"
                autocomplete="new-password"
                required
                :maxlength="MAX_LENGTH"
                :placeholder="t('register.reset.confirmPlaceholder')"
                class="input h-10 pr-10"
                :class="confirmError ? '!border-danger/60 focus:!ring-danger/20' : matches ? '!border-success/50 focus:!ring-success/20' : ''"
                :aria-invalid="Boolean(confirmError)"
                aria-describedby="reset-confirm-hint"
                @blur="confirmTouched = true"
              />
              <Transition
                enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
                enter-from-class="scale-50 opacity-0"
                leave-to-class="scale-50 opacity-0"
              >
                <UiIcon
                  v-if="matches"
                  name="check"
                  :size="16"
                  class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-success"
                />
              </Transition>
            </span>
            <p id="reset-confirm-hint" class="mt-1.5 min-h-[1rem] text-xs" aria-live="polite">
              <span v-if="confirmError" class="flex items-center gap-1 text-danger">
                <UiIcon name="alert" :size="12" />
                {{ confirmError }}
              </span>
              <span v-else-if="matches" class="flex items-center gap-1 text-success">
                <UiIcon name="check-circle" :size="12" />
                {{ t("register.reset.match") }}
              </span>
            </p>
          </div>

          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
            leave-to-class="opacity-0"
          >
            <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>
          </Transition>

          <button type="submit" class="btn btn-primary h-10 w-full" :disabled="submitting" :aria-busy="submitting">
            <UiIcon :name="submitting ? 'loader' : 'lock'" :size="16" :spin="submitting" />
            {{ submitting ? t("register.reset.submitting") : t("register.reset.submit") }}
          </button>
        </form>

        <p class="mt-6 border-t border-line/70 pt-4 text-center text-xs">
          <RouterLink to="/login" class="inline-flex items-center gap-1 font-medium text-fg-muted transition-colors hover:text-fg">
            <UiIcon name="chevron-left" :size="12" />
            {{ t("register.backToLogin") }}
          </RouterLink>
        </p>
      </div>
    </Transition>
  </AuthLayout>
</template>

<style scoped>
.done-mark {
  animation: done-pop 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes done-pop {
  0% {
    opacity: 0;
    transform: scale(0.6);
  }
  60% {
    opacity: 1;
    transform: scale(1.06);
  }
  100% {
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .done-mark {
    animation: none;
  }
}
</style>
