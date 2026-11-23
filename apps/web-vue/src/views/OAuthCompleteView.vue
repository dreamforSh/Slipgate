<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";

/**
 * Landing page of third-party sign-in: the BFF redirects here with `#code=…`, a one-time hand-off
 * code (fragment only: never sent to servers or logs, and removed from the address bar first).
 * The code is traded for a session by the BFF only in the browser that started the sign-in (its
 * binding cookie rides along with this same-origin request), so a link to this page made by
 * someone else cannot swap the visitor's session for theirs. A token in the URL is never adopted.
 */
const { t, te } = useI18n();
const auth = useAuthStore();
const portal = usePortalStore();
const router = useRouter();
const failed = ref(false);
const errorCode = ref("session");

const errorText = computed(() => {
  if (!/^[a-z_]+$/.test(errorCode.value)) return t("register.oauth.errors.session");
  // Provider round trip errors first, then the sign-in guards' (backend mode …).
  for (const key of [`register.oauth.errors.${errorCode.value}`, `authGuards.oauthErrors.${errorCode.value}`, `authGuards.errors.${errorCode.value}`]) {
    if (te(key)) return t(key);
  }
  return t("register.oauth.errors.session");
});

onMounted(async () => {
  const code = new URLSearchParams(window.location.hash.slice(1)).get("code") ?? "";
  history.replaceState(null, "", window.location.pathname);
  if (!code) {
    failed.value = true;
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
  if (!accessToken) {
    failed.value = true;
    return;
  }
  // Only now, with a session the BFF handed to this browser, is any existing one replaced.
  auth.adoptToken(accessToken);
  await auth.hydrateSession();
  if (!auth.isAuthenticated) {
    failed.value = true;
    return;
  }
  const safe = redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "";
  await router.replace(safe || (auth.isAdmin ? "/admin" : "/dashboard"));
});
</script>

<template>
  <AuthLayout :site-name="portal.siteName">
    <div class="card p-8 text-center">
      <template v-if="!failed">
        <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          <UiIcon name="loader" :size="22" spin />
        </span>
        <p class="mt-4 text-sm font-medium text-fg">{{ t("register.oauth.completing") }}</p>
      </template>
      <template v-else>
        <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
          <UiIcon name="x-circle" :size="22" />
        </span>
        <p class="mt-4 text-base font-semibold text-fg">{{ t("register.oauth.failedTitle") }}</p>
        <p class="mt-1 text-sm text-fg-muted">{{ errorText }}</p>
        <RouterLink to="/login" class="btn btn-primary mt-6">{{ t("register.oauth.backToLogin") }}</RouterLink>
      </template>
    </div>
  </AuthLayout>
</template>
