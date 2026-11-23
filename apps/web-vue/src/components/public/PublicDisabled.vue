<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import UiIcon from "../ui/UiIcon.vue";

/** Friendly placeholder for a public page the administrator switched off (the API answers 404). */
const { t } = useI18n();
const auth = useAuthStore();
const consolePath = computed(() => (auth.isAuthenticated ? (auth.isAdmin ? "/admin" : "/dashboard") : "/login"));
</script>

<template>
  <div class="mx-auto flex w-full max-w-lg flex-col items-center px-4 py-20 text-center animate-slide-up sm:py-28">
    <span class="relative inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line">
      <span class="absolute inset-0 rounded-2xl bg-gradient-to-b from-accent/10 to-transparent" aria-hidden="true" />
      <UiIcon name="lock" :size="26" :stroke-width="1.6" />
    </span>
    <h1 class="mt-6 text-xl font-semibold tracking-tight text-fg">{{ t("public.disabled.title") }}</h1>
    <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("public.disabled.desc") }}</p>
    <div class="mt-7 flex flex-wrap items-center justify-center gap-2">
      <RouterLink to="/home" class="btn btn-secondary">
        <UiIcon name="home" :size="15" />
        {{ t("public.common.backHome") }}
      </RouterLink>
      <RouterLink :to="consolePath" class="btn btn-primary">
        <UiIcon :name="auth.isAuthenticated ? 'dashboard' : 'log-in'" :size="15" />
        {{ auth.isAuthenticated ? t("publicNav.console") : t("public.disabled.login") }}
      </RouterLink>
    </div>
  </div>
</template>
