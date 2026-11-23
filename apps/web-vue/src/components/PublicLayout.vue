<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";
import BrandMark from "./BrandMark.vue";
import LocaleSwitcher from "./LocaleSwitcher.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import UiIcon from "./ui/UiIcon.vue";
import type { IconName } from "./ui/icons";

/** Chrome for unauthenticated pages: brand, public navigation, theme/locale and sign-in. */
const { t } = useI18n();
const auth = useAuthStore();
const portal = usePortalStore();
const route = useRoute();
const menuOpen = ref(false);

onMounted(() => void portal.load());

interface Link {
  to?: string;
  href?: string;
  label: string;
  icon: IconName;
}

const links = computed<Link[]>(() => {
  const s = portal.settings;
  const out: Link[] = [];
  if (s?.modelPlazaEnabled !== false) out.push({ to: "/models", label: t("publicNav.models"), icon: "store" });
  if (s?.statusPageEnabled !== false) out.push({ to: "/status", label: t("publicNav.status"), icon: "activity" });
  if (s?.keyUsageLookupEnabled !== false) out.push({ to: "/key-usage", label: t("publicNav.keyUsage"), icon: "search" });
  if (s?.docUrl) out.push({ href: s.docUrl, label: t("publicNav.docs"), icon: "book-open" });
  for (const l of s?.customNavLinks ?? []) out.push({ href: l.url, label: l.label, icon: "external-link" });
  return out;
});

const consolePath = computed(() => (auth.isAdmin ? "/admin" : "/dashboard"));
const year = new Date().getFullYear();
</script>

<template>
  <div class="relative flex min-h-screen flex-col">
    <div class="public-ambient pointer-events-none fixed inset-x-0 top-0 h-[560px]" aria-hidden="true" />

    <header class="glass sticky top-0 z-30 border-b border-line/60">
      <div class="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <RouterLink to="/home" class="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity hover:opacity-85">
          <img v-if="portal.logoUrl" :src="portal.logoUrl" alt="" class="h-8 w-8 rounded-lg object-contain" />
          <BrandMark v-else :size="32" glow />
          <span class="truncate text-base font-bold tracking-tight text-fg">{{ portal.siteName }}</span>
        </RouterLink>

        <nav class="ml-4 hidden items-center gap-1 md:flex" :aria-label="t('publicNav.label')">
          <template v-for="l in links" :key="l.label">
            <RouterLink v-if="l.to" :to="l.to" class="pub-link" :class="{ 'pub-link-active': route.path === l.to }">
              {{ l.label }}
            </RouterLink>
            <a v-else :href="l.href" target="_blank" rel="noopener noreferrer" class="pub-link">
              {{ l.label }}
              <UiIcon name="external-link" :size="12" class="opacity-60" />
            </a>
          </template>
        </nav>

        <div class="ml-auto flex items-center gap-1.5">
          <LocaleSwitcher />
          <ThemeSwitcher compact />
          <RouterLink v-if="auth.isAuthenticated" :to="consolePath" class="btn btn-primary btn-sm hidden sm:inline-flex">
            <UiIcon name="dashboard" :size="14" />
            {{ t("publicNav.console") }}
          </RouterLink>
          <RouterLink v-else to="/login" class="btn btn-primary btn-sm hidden sm:inline-flex">
            <UiIcon name="log-in" :size="14" />
            {{ t("publicNav.login") }}
          </RouterLink>
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm md:hidden"
            :aria-expanded="menuOpen"
            :aria-label="t('nav.openMenu')"
            @click="menuOpen = !menuOpen"
          >
            <UiIcon :name="menuOpen ? 'x' : 'menu'" :size="18" />
          </button>
        </div>
      </div>
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-1"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <nav v-if="menuOpen" class="border-t border-line/60 px-4 py-2 md:hidden">
          <template v-for="l in links" :key="l.label">
            <RouterLink v-if="l.to" :to="l.to" class="pub-mobile-link" @click="menuOpen = false">
              <UiIcon :name="l.icon" :size="16" />{{ l.label }}
            </RouterLink>
            <a v-else :href="l.href" target="_blank" rel="noopener noreferrer" class="pub-mobile-link">
              <UiIcon :name="l.icon" :size="16" />{{ l.label }}
            </a>
          </template>
          <RouterLink :to="auth.isAuthenticated ? consolePath : '/login'" class="pub-mobile-link text-accent" @click="menuOpen = false">
            <UiIcon :name="auth.isAuthenticated ? 'dashboard' : 'log-in'" :size="16" />
            {{ auth.isAuthenticated ? t("publicNav.console") : t("publicNav.login") }}
          </RouterLink>
        </nav>
      </Transition>
    </header>

    <main class="relative flex-1">
      <slot />
    </main>

    <footer class="relative border-t border-line/60">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-fg-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>© {{ year }} {{ portal.siteName }}<span v-if="portal.settings?.footerText"> · {{ portal.settings.footerText }}</span></p>
        <!-- Agreement documents (terms, privacy …) published at /legal/:id -->
        <nav
          v-if="portal.settings?.loginAgreementDocuments?.length"
          class="flex flex-wrap items-center gap-x-3 gap-y-1"
          :aria-label="t('authGuards.legal.title')"
        >
          <RouterLink
            v-for="d in portal.settings.loginAgreementDocuments"
            :key="d.id"
            :to="{ name: 'legal-document', params: { documentId: d.id } }"
            class="transition-colors hover:text-fg"
          >
            {{ d.title }}
          </RouterLink>
        </nav>
        <p v-if="portal.settings?.contactInfo" class="truncate">{{ portal.settings.contactInfo }}</p>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.public-ambient {
  background:
    radial-gradient(ellipse 55% 60% at 75% -10%, rgb(var(--accent-glow) / 0.14), transparent 70%),
    radial-gradient(ellipse 45% 55% at 10% 0%, rgb(var(--info) / 0.07), transparent 70%);
}
.pub-link {
  @apply inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium text-fg-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg;
}
.pub-link-active {
  @apply bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent;
}
.pub-mobile-link {
  @apply flex items-center gap-2.5 rounded-lg px-2 py-2.5 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg;
}
</style>
