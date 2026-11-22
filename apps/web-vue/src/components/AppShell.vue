<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import BrandMark from "./BrandMark.vue";
import LocaleSwitcher from "./LocaleSwitcher.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  exact?: boolean;
  /** A collapsible group: the parent only toggles; `to` is where the icon rail sends a click. */
  children?: NavItem[];
}
interface NavSection {
  title: string;
  items: NavItem[];
}

const sections = computed<NavSection[]>(() => {
  const out: NavSection[] = [];
  if (auth.isAdmin) {
    out.push({
      title: t("nav.sections.admin"),
      items: [
        { to: "/admin", label: t("nav.dashboard"), icon: "dashboard", exact: true },
        { to: "/admin/groups", label: t("nav.groups"), icon: "layers" },
        { to: "/admin/accounts", label: t("nav.accounts"), icon: "users" },
        {
          to: "/admin/proxy",
          label: t("nav.proxy"),
          icon: "globe",
          children: [
            { to: "/admin/proxy/clash", label: t("nav.proxyClash"), icon: "network" },
            { to: "/admin/proxy/ips", label: t("nav.proxyIps"), icon: "route" },
          ],
        },
        { to: "/admin/vms", label: t("nav.vms"), icon: "server" },
      ],
    });
  }
  out.push({
    title: t("nav.sections.account"),
    items: [{ to: "/user", label: t("nav.keys"), icon: "key" }],
  });
  return out;
});

function isActive(item: NavItem) {
  return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`);
}

/* ---------------- Collapsible groups ---------------- */
// A group follows the route (open while one of its pages is active) until the admin toggles
// it; that choice then wins, so an active group can still be folded away.
const groupOverrides = ref(new Map<string, boolean>());

function isGroupExpanded(item: NavItem) {
  return groupOverrides.value.get(item.to) ?? isActive(item);
}

function onGroupClick(item: NavItem) {
  if (rail.value) {
    // The icon rail has no room for children: jump to the active child or the first one.
    const target = item.children?.find(isActive) ?? item.children?.[0];
    if (target) void router.push(target.to);
    return;
  }
  const next = new Map(groupOverrides.value);
  next.set(item.to, !isGroupExpanded(item));
  groupOverrides.value = next;
}

const activeSection = computed(() => sections.value.find((s) => s.items.some(isActive)));
const activeGroup = computed(() => activeSection.value?.items.find((i) => i.children?.length && isActive(i)) ?? null);
const pageTitle = computed(() =>
  route.meta.titleKey ? t(route.meta.titleKey) : (activeSection.value?.items.find(isActive)?.label ?? ""),
);

const siteName = computed(() => auth.setupStatus?.siteName || "Slipgate");
const homePath = computed(() => (auth.isAdmin ? "/admin" : "/user"));
const email = computed(() => auth.user?.email ?? "");
const initials = computed(() => (email.value || "?").slice(0, 1).toUpperCase());
const roleLabel = computed(() => (auth.isAdmin ? t("shell.roles.admin") : t("shell.roles.user")));
const balance = computed(() => auth.wallet?.formattedAvailableUsd ?? null);

/* ---------------- Sidebar: desktop rail collapse + mobile drawer ---------------- */
const COLLAPSE_KEY = "slipgate_sidebar_collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

const collapsed = ref(readCollapsed());
const mobileOpen = ref(false);

const desktopQuery = window.matchMedia("(min-width: 1024px)");
const isDesktop = ref(desktopQuery.matches);
function onDesktopChange(ev: MediaQueryListEvent) {
  isDesktop.value = ev.matches;
  if (ev.matches) mobileOpen.value = false;
}

/** The icon-only rail only exists on desktop; the mobile drawer is always full width. */
const rail = computed(() => collapsed.value && isDesktop.value);

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? "1" : "0");
  } catch {
    // Storage may be unavailable (private mode); the toggle still works for this visit.
  }
}

/* ---------------- User menu ---------------- */
const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);

function onPointerDown(ev: PointerEvent) {
  if (menuOpen.value && menuRoot.value && !menuRoot.value.contains(ev.target as Node)) {
    menuOpen.value = false;
  }
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key !== "Escape") return;
  menuOpen.value = false;
  mobileOpen.value = false;
}

onMounted(() => {
  desktopQuery.addEventListener("change", onDesktopChange);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  desktopQuery.removeEventListener("change", onDesktopChange);
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeydown);
});

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
    menuOpen.value = false;
  },
);

async function handleLogout() {
  menuOpen.value = false;
  auth.logout();
  await router.push("/login");
}
</script>

<template>
  <div class="relative min-h-screen">
    <!-- Ambient accent wash behind the content area -->
    <div class="ambient pointer-events-none fixed inset-x-0 top-0 h-[480px]" aria-hidden="true" />

    <!-- Mobile scrim -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="mobileOpen" class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] lg:hidden" @click="mobileOpen = false" />
    </Transition>

    <!-- Sidebar -->
    <aside
      class="sidebar fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line/80 bg-surface lg:z-30"
      :class="[
        rail ? 'lg:w-[72px]' : 'lg:w-64',
        mobileOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full lg:translate-x-0',
      ]"
      :aria-label="t('nav.main')"
    >
      <div class="flex h-16 shrink-0 items-center gap-3 border-b border-line/70 px-[18px]">
        <RouterLink :to="homePath" class="shrink-0 rounded-[10px] transition-opacity hover:opacity-85" :title="siteName">
          <BrandMark :size="36" glow />
        </RouterLink>
        <div class="fade-x min-w-0 flex-1 leading-tight" :class="{ 'fade-x-hidden': rail }" :aria-hidden="rail">
          <RouterLink :to="homePath" class="block truncate text-base font-bold tracking-tight text-fg hover:text-accent">
            {{ siteName }}
          </RouterLink>
        </div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm -mr-1.5 lg:hidden" :aria-label="t('nav.closeMenu')" @click="mobileOpen = false">
          <UiIcon name="x" :size="16" />
        </button>
      </div>

      <nav class="scrollbar-hide flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        <div v-for="section in sections" :key="section.title" class="mb-5 last:mb-0">
          <p class="nav-section" :class="{ 'nav-section-rail': rail }">
            <span class="fade-x" :class="{ 'fade-x-hidden': rail }" :aria-hidden="rail">{{ section.title }}</span>
          </p>
          <ul class="space-y-1">
            <li v-for="item in section.items" :key="item.to">
              <template v-if="item.children?.length">
                <button
                  type="button"
                  class="nav-link w-full"
                  :class="{ 'nav-link-active': isActive(item) && (rail || !isGroupExpanded(item)), 'nav-link-rail': rail }"
                  :title="rail ? item.label : undefined"
                  :aria-expanded="rail ? undefined : isGroupExpanded(item)"
                  @click="onGroupClick(item)"
                >
                  <UiIcon :name="item.icon" :size="18" />
                  <span class="fade-x flex min-w-0 flex-1 items-center justify-between gap-2" :class="{ 'fade-x-hidden': rail }">
                    <span class="truncate">{{ item.label }}</span>
                    <UiIcon
                      name="chevron-down"
                      :size="14"
                      class="shrink-0 text-fg-subtle transition-transform duration-200"
                      :class="isGroupExpanded(item) ? 'rotate-180' : ''"
                    />
                  </span>
                </button>
                <ul v-if="!rail && isGroupExpanded(item)" class="mb-1 ml-[1.35rem] mt-1 space-y-0.5 border-l border-line/80 pl-2">
                  <li v-for="child in item.children" :key="child.to">
                    <RouterLink
                      :to="child.to"
                      class="nav-link nav-link-child"
                      :class="{ 'nav-link-active': isActive(child) }"
                      :aria-current="isActive(child) ? 'page' : undefined"
                    >
                      <UiIcon :name="child.icon" :size="15" />
                      <span class="truncate">{{ child.label }}</span>
                    </RouterLink>
                  </li>
                </ul>
              </template>
              <RouterLink
                v-else
                :to="item.to"
                class="nav-link"
                :class="{ 'nav-link-active': isActive(item), 'nav-link-rail': rail }"
                :title="rail ? item.label : undefined"
                :aria-current="isActive(item) ? 'page' : undefined"
              >
                <UiIcon :name="item.icon" :size="18" />
                <span class="fade-x truncate" :class="{ 'fade-x-hidden': rail }">{{ item.label }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </nav>

      <div class="flex shrink-0 gap-1.5 border-t border-line/70 p-3" :class="rail ? 'flex-col items-center' : 'items-center'">
        <ThemeSwitcher v-if="!rail" class="flex-1" />
        <ThemeSwitcher v-else compact />
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm hidden lg:inline-flex"
          :title="rail ? t('nav.expand') : t('nav.collapse')"
          :aria-label="rail ? t('nav.expand') : t('nav.collapse')"
          :aria-expanded="!rail"
          @click="toggleCollapsed"
        >
          <UiIcon :name="rail ? 'panel-left-open' : 'panel-left-close'" :size="16" />
        </button>
      </div>
    </aside>

    <!-- Content column -->
    <div class="content relative min-h-screen" :class="rail ? 'lg:pl-[72px]' : 'lg:pl-64'">
      <header class="glass sticky top-0 z-30 border-b border-line/70">
        <div class="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div class="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-sm -ml-1.5 lg:hidden"
              :aria-label="t('nav.openMenu')"
              @click="mobileOpen = true"
            >
              <UiIcon name="menu" :size="18" />
            </button>
            <RouterLink :to="homePath" class="shrink-0 lg:hidden" :title="siteName">
              <BrandMark :size="28" />
            </RouterLink>
            <span class="truncate text-sm font-semibold tracking-tight text-fg sm:hidden">{{ siteName }}</span>
            <nav :aria-label="t('nav.breadcrumb')" class="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
              <template v-if="activeSection">
                <span class="whitespace-nowrap text-fg-subtle">{{ activeSection.title }}</span>
                <UiIcon name="chevron-right" :size="14" class="text-fg-subtle/70" />
              </template>
              <template v-if="activeGroup">
                <span class="whitespace-nowrap text-fg-subtle">{{ activeGroup.label }}</span>
                <UiIcon name="chevron-right" :size="14" class="text-fg-subtle/70" />
              </template>
              <span class="truncate font-semibold tracking-tight text-fg">{{ pageTitle }}</span>
            </nav>
          </div>

          <div class="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            <LocaleSwitcher />
            <RouterLink
              v-if="balance"
              to="/user"
              class="hidden items-center gap-2 rounded-lg bg-accent/10 px-2.5 py-1.5 text-accent ring-1 ring-inset ring-accent/20 transition-colors hover:bg-accent/15 sm:inline-flex"
              :title="t('shell.balance')"
            >
              <UiIcon name="wallet" :size="15" />
              <span class="font-mono text-sm font-semibold tabular-nums">{{ balance }}</span>
            </RouterLink>

            <span class="hidden h-6 w-px bg-line sm:block" aria-hidden="true" />

            <div ref="menuRoot" class="relative">
              <button
                type="button"
                class="flex items-center gap-2.5 rounded-lg p-1 pr-1.5 transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :aria-label="t('shell.accountMenu')"
                @click="menuOpen = !menuOpen"
              >
                <span
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-solid text-xs font-semibold text-accent-fg ring-2 ring-surface"
                >
                  {{ initials }}
                </span>
                <span class="hidden min-w-0 max-w-[12rem] text-left leading-tight md:block">
                  <span class="block truncate text-sm font-medium text-fg">{{ email }}</span>
                  <span class="block text-2xs text-fg-subtle">{{ roleLabel }}</span>
                </span>
                <UiIcon
                  name="chevron-down"
                  :size="14"
                  class="hidden text-fg-subtle transition-transform duration-200 md:block"
                  :class="{ 'rotate-180': menuOpen }"
                />
              </button>

              <div
                v-if="menuOpen"
                class="menu-panel absolute right-0 top-full mt-2 w-64 origin-top-right animate-scale-in"
                role="menu"
              >
                <div class="flex items-center gap-3 px-2.5 pb-3 pt-2">
                  <span
                    class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent"
                  >
                    {{ initials }}
                  </span>
                  <div class="min-w-0 leading-tight">
                    <p class="truncate text-sm font-medium text-fg" :title="email">{{ email }}</p>
                    <p class="mt-0.5 text-2xs text-fg-subtle">{{ roleLabel }}</p>
                  </div>
                </div>
                <div v-if="balance" class="mx-1 mb-1 flex items-center justify-between rounded-lg bg-surface-2 px-2.5 py-2 sm:hidden">
                  <span class="text-xs text-fg-subtle">{{ t("shell.balance") }}</span>
                  <span class="font-mono text-sm font-semibold tabular-nums text-accent">{{ balance }}</span>
                </div>
                <div class="border-t border-line/70 py-1">
                  <RouterLink to="/user" class="menu-item" role="menuitem">
                    <UiIcon name="key" :size="15" />
                    {{ t("nav.keys") }}
                  </RouterLink>
                  <RouterLink v-if="auth.isAdmin" to="/admin" class="menu-item" role="menuitem">
                    <UiIcon name="dashboard" :size="15" />
                    {{ t("nav.dashboard") }}
                  </RouterLink>
                </div>
                <div class="border-t border-line/70 pt-1">
                  <button type="button" class="menu-item hover:!bg-danger/10 hover:!text-danger" role="menuitem" @click="handleLogout">
                    <UiIcon name="logout" :size="15" />
                    {{ t("shell.logout") }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main class="relative">
        <div class="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.ambient {
  background:
    radial-gradient(ellipse 60% 70% at 70% -10%, rgb(var(--accent-glow) / 0.1), transparent 70%),
    radial-gradient(ellipse 40% 50% at 15% -5%, rgb(var(--info) / 0.05), transparent 70%);
}

.sidebar {
  transition-property: width, transform;
  transition-duration: 250ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

.content {
  transition: padding-left 250ms cubic-bezier(0.2, 0, 0, 1);
}

/* Labels slide/fade out as the sidebar collapses to the icon rail. */
.fade-x {
  max-width: 13rem;
  overflow: hidden;
  white-space: nowrap;
  transition:
    max-width 200ms ease,
    opacity 140ms ease,
    transform 140ms ease;
}
.fade-x-hidden {
  max-width: 0;
  opacity: 0;
  transform: translateX(-4px);
  pointer-events: none;
}

.nav-section {
  @apply relative mb-1.5 flex min-h-[1.25rem] items-center px-3 text-[11px] font-semibold tracking-wide text-fg-subtle;
}
/* In the rail the section title collapses into a short divider. */
.nav-section::after {
  content: "";
  @apply absolute inset-x-4 top-1/2 h-px bg-line opacity-0 transition-opacity duration-200;
}
.nav-section-rail::after {
  @apply opacity-100;
}

.nav-link {
  @apply relative flex h-9 items-center gap-3 overflow-hidden rounded-lg px-3 text-sm font-medium text-fg-muted;
  @apply transition-colors duration-150 hover:bg-surface-2 hover:text-fg;
  @apply focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40;
  padding-left: 0.8125rem;
}
.nav-link > svg {
  @apply text-fg-subtle transition-colors;
}
.nav-link:hover > svg {
  @apply text-fg-muted;
}
.nav-link-child {
  @apply h-8 gap-2.5 text-[13px];
}
.nav-link-rail {
  @apply gap-0;
  padding-left: 0.9375rem;
}
.nav-link-active,
.nav-link-active:hover {
  @apply bg-accent/10 text-accent;
}
.nav-link-active > svg,
.nav-link-active:hover > svg {
  @apply text-accent;
}
.nav-link-active::before {
  content: "";
  @apply absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-accent;
  animation: nav-indicator-in 220ms cubic-bezier(0.2, 0, 0, 1);
}

@keyframes nav-indicator-in {
  from {
    opacity: 0;
    transform: scaleY(0.3);
  }
}
</style>
