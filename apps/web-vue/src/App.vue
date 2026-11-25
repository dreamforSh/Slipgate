<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterView, useRoute, useRouter } from "vue-router";
import AnnouncementPopup from "./components/AnnouncementPopup.vue";
import AppShell from "./components/AppShell.vue";
import RouteProgress from "./components/ui/RouteProgress.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import { syncDocumentTitle } from "./router";
import { useAnnouncementStore } from "./stores/announcements";
import { useAuthStore } from "./stores/auth";
import { useThemeStore } from "./stores/theme";

useThemeStore();
const route = useRoute();
const auth = useAuthStore();
const announcements = useAnnouncementStore();
const { locale } = useI18n();

// Re-title the browser tab when the language changes (route changes are handled by the router).
watch(locale, () => syncDocumentTitle());

// Backend (admin-only) mode ended this session mid-way: leave the console for the sign-in page.
const router = useRouter();
watch(
  () => auth.sessionNotice,
  (notice) => {
    if (notice && route.meta.requiresAuth) void router.replace("/login");
  },
);

/** Login/setup and public pages render their own chrome. */
const isBare = computed(() => route.meta.layout === "auth" || route.meta.layout === "public");

// The announcement feed follows the session: load on sign-in, re-check on navigation (the
// store throttles), clear on sign-out.
watch(
  () => auth.isAuthenticated,
  (signedIn) => (signedIn ? void announcements.refresh(true) : announcements.reset()),
  { immediate: true },
);
watch(
  () => route.path,
  () => {
    if (auth.isAuthenticated) void announcements.refresh();
  },
);
function onVisible() {
  if (document.visibilityState === "visible" && auth.isAuthenticated) void announcements.refresh();
}
onMounted(() => document.addEventListener("visibilitychange", onVisible));
onBeforeUnmount(() => document.removeEventListener("visibilitychange", onVisible));
</script>

<template>
  <RouteProgress />
  <RouterView v-if="isBare" v-slot="{ Component, route: r }">
    <Transition name="route" mode="out-in">
      <component :is="Component" :key="r.path" />
    </Transition>
  </RouterView>
  <AppShell v-else>
    <!-- The wrapper fades as a whole; .route-stagger then cascades the view's sections in. -->
    <RouterView v-slot="{ Component, route: r }">
      <Transition name="route" mode="out-in">
        <div :key="r.path" class="route-stagger">
          <component :is="Component" />
        </div>
      </Transition>
    </RouterView>
  </AppShell>
  <AnnouncementPopup v-if="auth.isAuthenticated && !isBare" />
  <ToastHost />
</template>
