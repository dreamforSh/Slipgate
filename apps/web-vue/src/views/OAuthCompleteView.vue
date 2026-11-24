<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRouter } from "vue-router";
import type { OAuthPendingSignupSummary } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import OAuthProviderMark from "../components/settings/OAuthProviderMark.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";

/**
 * Landing page of third-party sign-in: the BFF redirects here with `#code=…` (one-time hand-off)
 * or `#continue=…` (invite-only sign-up continuation bound to the same browser cookie).
 */
const { t, te } = useI18n();
const auth = useAuthStore();
const portal = usePortalStore();
const router = useRouter();

const mode = ref<"completing" | "continue" | "failed">("completing");
const errorCode = ref("session");
const continueError = ref<string | null>(null);
const continueToken = ref("");
const pendingInfo = ref<OAuthPendingSignupSummary | null>(null);
const submitting = ref(false);

const form = reactive({
  username: "",
  inviteCode: "",
  promoCode: "",
  affCode: "",
});

const errorText = computed(() => {
  if (!/^[a-z_]+$/.test(errorCode.value)) return t("register.oauth.errors.session");
  for (const key of [`register.oauth.errors.${errorCode.value}`, `authGuards.oauthErrors.${errorCode.value}`, `authGuards.errors.${errorCode.value}`]) {
    if (te(key)) return t(key);
  }
  return t("register.oauth.errors.session");
});

async function finishSession(accessToken: string, redirect: string): Promise<boolean> {
  auth.adoptToken(accessToken);
  await auth.hydrateSession();
  if (!auth.isAuthenticated) return false;
  const safe = redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "";
  await router.replace(safe || (auth.isAdmin ? "/admin" : "/dashboard"));
  return true;
}

async function submitContinue() {
  if (!continueToken.value || submitting.value) return;
  continueError.value = null;
  submitting.value = true;
  try {
    const res = await fetch("/api/v1/auth/oauth/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: continueToken.value,
        username: form.username.trim() || undefined,
        inviteCode: form.inviteCode.trim() || undefined,
        promoCode: form.promoCode.trim() || undefined,
        affCode: form.affCode.trim() || undefined,
      }),
    });
    const data = (await res.json().catch(() => null)) as {
      accessToken?: unknown;
      redirect?: unknown;
      error?: unknown;
      message?: unknown;
    } | null;
    if (res.ok && typeof data?.accessToken === "string") {
      const ok = await finishSession(data.accessToken, typeof data.redirect === "string" ? data.redirect : "");
      if (!ok) {
        errorCode.value = "session";
        mode.value = "failed";
      }
      return;
    }
    const err = typeof data?.error === "string" ? data.error : "";
    if (err === "invite_required" || err === "invalid_promo_code") {
      continueError.value = t(`register.errors.${err}`);
    } else if (err && te(`authGuards.errors.${err}`)) {
      continueError.value = t(`authGuards.errors.${err}`);
    } else if (err && te(`register.oauth.errors.${err}`)) {
      continueError.value = t(`register.oauth.errors.${err}`);
    } else {
      continueError.value = typeof data?.message === "string" ? data.message : t("register.oauth.errors.session");
    }
  } catch {
    continueError.value = t("common.networkError");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const code = hash.get("code") ?? "";
  const cont = hash.get("continue") ?? "";
  history.replaceState(null, "", window.location.pathname);

  if (cont) {
    continueToken.value = cont;
    try {
      const res = await fetch(`/api/v1/auth/oauth/pending/${encodeURIComponent(cont)}`);
      const data = (await res.json().catch(() => null)) as (Partial<OAuthPendingSignupSummary> & { error?: unknown }) | null;
      if (res.ok && data?.provider) {
        pendingInfo.value = data as OAuthPendingSignupSummary;
        form.username = data.suggestedUsername ?? "";
        mode.value = "continue";
        return;
      }
      if (typeof data?.error === "string") errorCode.value = data.error;
    } catch {
      // Handled by fallback failed state below.
    }
    mode.value = "failed";
    return;
  }

  if (!code) {
    mode.value = "failed";
    return;
  }
  let accessToken = "";
  let redirect = "";
  try {
    const res = await fetch("/api/v1/auth/oauth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json().catch(() => null)) as { accessToken?: unknown; redirect?: unknown; error?: unknown } | null;
    if (res.ok && typeof data?.accessToken === "string") {
      accessToken = data.accessToken;
      redirect = typeof data.redirect === "string" ? data.redirect : "";
    } else if (typeof data?.error === "string") {
      errorCode.value = data.error;
    }
  } catch {
    // Offline: shown as an invalid session below.
  }
  if (!accessToken || !(await finishSession(accessToken, redirect))) {
    mode.value = "failed";
  }
});
</script>

<template>
  <AuthLayout :site-name="portal.siteName">
    <div v-if="mode === 'completing'" class="card p-8 text-center">
      <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
        <UiIcon name="loader" :size="22" spin />
      </span>
      <p class="mt-4 text-sm font-medium text-fg">{{ t("register.oauth.completing") }}</p>
    </div>

    <div v-else-if="mode === 'continue' && pendingInfo" class="card p-6 sm:p-8">
      <div class="flex items-center gap-3">
        <img
          v-if="pendingInfo.avatarUrl"
          :src="pendingInfo.avatarUrl"
          alt=""
          class="h-11 w-11 rounded-xl border border-line object-cover"
        />
        <span v-else class="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <OAuthProviderMark :provider="pendingInfo.provider" :size="20" />
        </span>
        <div class="min-w-0">
          <h1 class="text-base font-semibold text-fg">{{ t("register.oauthContinue.title") }}</h1>
          <p class="truncate text-xs text-fg-muted">
            {{ t("register.oauthContinue.subtitle", { name: pendingInfo.displayName }) }}
          </p>
        </div>
      </div>

      <UiAlert v-if="continueError" tone="danger" class="mt-4">
        {{ continueError }}
      </UiAlert>

      <form class="mt-5 space-y-4" @submit.prevent="submitContinue">
        <label class="block">
          <span class="label">{{ t("register.oauthContinue.username") }}</span>
          <input v-model="form.username" type="text" maxlength="64" class="input h-10" :placeholder="t('register.oauthContinue.usernamePlaceholder')" />
        </label>

        <label v-if="pendingInfo.inviteRequired" class="block">
          <span class="label">{{ t("register.invite") }}</span>
          <input
            v-model="form.inviteCode"
            type="text"
            required
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
            class="input h-10 font-mono"
            :placeholder="t('register.invitePlaceholder')"
          />
          <span class="hint">{{ t("register.inviteRequiredHint") }}</span>
        </label>

        <label v-if="pendingInfo.promoCodeEnabled" class="block">
          <span class="label flex items-center justify-between">
            {{ t("register.promo") }}
            <span class="font-normal text-fg-subtle">{{ t("register.optional") }}</span>
          </span>
          <input
            v-model="form.promoCode"
            type="text"
            maxlength="32"
            autocomplete="off"
            spellcheck="false"
            class="input h-10 font-mono"
            :placeholder="t('register.promoPlaceholder')"
          />
        </label>

        <button type="submit" class="btn btn-primary h-10 w-full" :disabled="submitting">
          <UiIcon v-if="submitting" name="loader" :size="15" spin />
          {{ submitting ? t("common.submitting") : t("register.oauthContinue.submit") }}
        </button>

        <div class="text-center">
          <RouterLink to="/login" class="text-xs text-fg-muted hover:text-fg">{{ t("register.oauth.backToLogin") }}</RouterLink>
        </div>
      </form>
    </div>

    <div v-else class="card p-8 text-center">
      <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
        <UiIcon name="x-circle" :size="22" />
      </span>
      <p class="mt-4 text-base font-semibold text-fg">{{ t("register.oauth.failedTitle") }}</p>
      <p class="mt-1 text-sm text-fg-muted">{{ errorText }}</p>
      <RouterLink to="/login" class="btn btn-primary mt-6">{{ t("register.oauth.backToLogin") }}</RouterLink>
    </div>
  </AuthLayout>
</template>
