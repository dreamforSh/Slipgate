<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";
import { useSystemUpdateStore } from "../stores/systemUpdate";
import AnnouncementBell from "./AnnouncementBell.vue";
import BrandMark from "./BrandMark.vue";
import LocaleSwitcher from "./LocaleSwitcher.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import AnimatedNumber from "./ui/AnimatedNumber.vue";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

const { t } = useI18n();
const auth = useAuthStore();
const portal = usePortalStore();
const systemUpdate = useSystemUpdateStore();
const route = useRoute();
const router = useRouter();

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  exact?: boolean;
  badgeDot?: boolean;
  badgeTone?: "accent" | "warning";
  /** External link (admin-defined nav links) rendered as a plain anchor in a new tab. */
  href?: string;
  /** A collapsible group: the parent only toggles; `to` is where the icon rail sends a click. */
  children?: NavItem[];
}
interface NavSection {
  title: string;
  items: NavItem[];
}

const sections = computed<NavSection[]>(() => {
  const out: NavSection[] = [];
  const settings = portal.settings;
  if (auth.isAdmin) {
    out.push(
      {
        title: t("nav.sections.overview"),
        items: [
          { to: "/admin", label: t("nav.dashboard"), icon: "dashboard", exact: true },
          { to: "/admin/ops", label: t("nav.ops"), icon: "activity" },
          { to: "/admin/usage", label: t("nav.adminUsage"), icon: "chart" },
        ],
      },
      {
        title: t("nav.sections.people"),
        items: [
          { to: "/admin/users", label: t("nav.users"), icon: "user" },
          { to: "/admin/groups", label: t("nav.groups"), icon: "layers" },
          { to: "/admin/subscriptions", label: t("nav.subscriptions"), icon: "crown" },
        ],
      },
      {
        title: t("nav.sections.resources"),
        items: [
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
          { to: "/admin/pricing", label: t("nav.pricing"), icon: "percent" },
          { to: "/admin/monitor", label: t("nav.channelMonitor"), icon: "radar" },
          { to: "/admin/vms", label: t("nav.vms"), icon: "server" },
        ],
      },
      {
        title: t("nav.sections.operations"),
        items: [
          { to: "/admin/announcements", label: t("nav.announcements"), icon: "megaphone" },
          { to: "/admin/redeem", label: t("nav.redeem"), icon: "ticket" },
          { to: "/admin/promo-codes", label: t("nav.promoCodes"), icon: "gift" },
          {
            to: "/admin/billing",
            label: t("nav.billing"),
            icon: "credit-card",
            children: [
              { to: "/admin/payments", label: t("nav.paymentDashboard"), icon: "trending-up" },
              { to: "/admin/orders", label: t("nav.paymentOrders"), icon: "list" },
              { to: "/admin/payment-plans", label: t("nav.paymentPlans"), icon: "box" },
              { to: "/admin/payment-settings", label: t("nav.paymentSettings"), icon: "sliders" },
            ],
          },
          { to: "/admin/affiliates", label: t("nav.affiliateRebates"), icon: "share" },
        ],
      },
      {
        title: t("nav.sections.system"),
        items: [
          { to: "/admin/risk", label: t("nav.risk"), icon: "shield-alert" },
          { to: "/admin/audit-logs", label: t("nav.auditLogs"), icon: "scroll" },
          { to: "/admin/system-logs", label: t("systemLogs.title"), icon: "terminal" },
          { to: "/admin/plugins", label: t("nav.plugins"), icon: "plug" },
          { to: "/admin/backup", label: t("nav.backup"), icon: "database" },
          {
            to: "/admin/updates",
            label: t("nav.updates"),
            icon: "download",
            badgeDot: systemUpdate.updateAvailable || systemUpdate.needsEdgeRestart,
            badgeTone: systemUpdate.needsEdgeRestart ? "warning" : "accent",
          },
          { to: "/admin/settings", label: t("nav.settings"), icon: "settings" },
        ],
      },
    );
  } else if (auth.isGroupManager) {
    out.push({
      title: t("nav.sections.admin"),
      items: [
        { to: "/admin/groups", label: t("nav.groups"), icon: "layers" },
        { to: "/admin/accounts", label: t("nav.accounts"), icon: "users" },
        { to: "/admin/users", label: t("nav.users"), icon: "user" },
        { to: "/admin/usage", label: t("nav.adminUsage"), icon: "chart" },
      ],
    });
  }
  const mine: NavItem[] = [
    { to: "/dashboard", label: t("nav.myDashboard"), icon: "gauge" },
    { to: "/keys", label: t("nav.keys"), icon: "key" },
    { to: "/usage", label: t("nav.myUsage"), icon: "activity" },
    { to: "/subscriptions", label: t("nav.mySubscriptions"), icon: "crown" },
    { to: "/redeem", label: t("nav.myRedeem"), icon: "ticket" },
  ];
  if (settings?.paymentEnabled) {
    mine.splice(4, 0, { to: "/purchase", label: t("nav.purchase"), icon: "credit-card" }, { to: "/orders", label: t("nav.orders"), icon: "list" });
  }
  if (settings?.affiliateEnabled) mine.push({ to: "/affiliate", label: t("nav.affiliate"), icon: "share" });
  if (settings?.modelPlazaEnabled !== false) mine.push({ to: "/models", label: t("nav.models"), icon: "store" });
  if (settings?.statusPageEnabled !== false) mine.push({ to: "/status", label: t("nav.status"), icon: "radar" });
    mine.push({ to: "/profile", label: t("nav.profile"), icon: "user" });
  out.push({ title: t("nav.sections.account"), items: mine });

  const links: NavItem[] = (settings?.customNavLinks ?? []).map((l, i) => ({
    to: `#link-${i}`,
    href: l.url,
    label: l.label,
    icon: "external-link",
  }));
  if (settings?.docUrl) links.unshift({ to: "#docs", href: settings.docUrl, label: t("publicNav.docs"), icon: "book-open" });
  if (links.length) out.push({ title: t("nav.sections.links"), items: links });
  return out;
});

function isActive(item: NavItem): boolean {
  if (item.href) return false;
  if (item.children?.length) return item.children.some(isActive);
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

/* ---------------- Rail flyouts ---------------- */
// The icon rail has no labels: hovering (or focusing) an item shows its name, and a group
// opens a small menu of its pages. Flyouts live on the <aside> (not inside the scrolling
// nav, which would clip them) and are placed next to the hovered row.
const asideEl = ref<HTMLElement | null>(null);
const flyout = ref<{ item: NavItem; top: number } | null>(null);
let flyoutTimer: number | undefined;

function showFlyout(item: NavItem, ev: Event) {
  if (!rail.value || !asideEl.value) return;
  window.clearTimeout(flyoutTimer);
  const row = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  flyout.value = { item, top: row.top - asideEl.value.getBoundingClientRect().top };
}

function hideFlyout(delay = 120) {
  window.clearTimeout(flyoutTimer);
  // A short grace period lets the pointer cross the gap into a group menu.
  flyoutTimer = window.setTimeout(() => (flyout.value = null), delay);
}

function keepFlyout() {
  window.clearTimeout(flyoutTimer);
}

const activeSection = computed(() => sections.value.find((s) => s.items.some(isActive)));
const activeGroup = computed(() => activeSection.value?.items.find((i) => i.children?.length && isActive(i)) ?? null);
const pageTitle = computed(() =>
  route.meta.titleKey ? t(route.meta.titleKey) : (activeSection.value?.items.find(isActive)?.label ?? ""),
);

const siteName = computed(() => portal.settings?.siteName || auth.setupStatus?.siteName || "Slipgate");
const logoUrl = computed(() => portal.logoUrl);
const homePath = computed(() => (auth.isAdmin ? "/admin" : auth.isGroupManager ? "/admin/groups" : "/dashboard"));
const email = computed(() => auth.user?.email ?? "");
const displayName = computed(() => auth.user?.username || email.value);
const initials = computed(() => (displayName.value || "?").slice(0, 1).toUpperCase());
const roleLabel = computed(() =>
  auth.isAdmin
    ? t("shell.roles.admin")
    : auth.isGroupManager
      ? t("shell.roles.group_manager")
      : t("shell.roles.user"),
);
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

/* ---------------- Header elevation ---------------- */
// Flat while the page is at the top; picks up a hairline shadow once content scrolls under it.
const scrolled = ref(false);
function onScroll() {
  scrolled.value = window.scrollY > 4;
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
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});
watch(
  () => auth.isAdmin,
  (isAdmin) => {
    if (isAdmin && !systemUpdate.status) {
      void systemUpdate.loadStatus(true);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  desktopQuery.removeEventListener("change", onDesktopChange);
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", onScroll);
});

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
    menuOpen.value = false;
    flyout.value = null;
  },
);
watch(rail, () => (flyout.value = null));
onBeforeUnmount(() => window.clearTimeout(flyoutTimer));

let signingOut = false;
async function handleLogout() {
  if (signingOut) return;
  signingOut = true;
  menuOpen.value = false;
  try {
    // Revokes this device's token on the server, then clears it locally (even when offline).
    await auth.signOut();
    await router.push("/login");
  } finally {
    signingOut = false;
  }
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
      ref="asideEl"
      class="sidebar fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line/80 bg-surface lg:z-30"
      :class="[
        rail ? 'lg:w-[72px]' : 'lg:w-64',
        mobileOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full lg:translate-x-0',
      ]"
      :aria-label="t('nav.main')"
    >
      <div class="flex h-16 shrink-0 items-center gap-3 border-b border-line/70 px-[18px]">
        <RouterLink :to="homePath" class="shrink-0 rounded-[10px] transition-opacity hover:opacity-85" :title="siteName">
          <img v-if="logoUrl" :src="logoUrl" alt="" class="h-9 w-9 rounded-[10px] object-contain" />
          <BrandMark v-else :size="36" glow />
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
            <li
              v-for="item in section.items"
              :key="item.to"
              @mouseenter="showFlyout(item, $event)"
              @mouseleave="hideFlyout()"
              @focusin="showFlyout(item, $event)"
              @focusout="hideFlyout(0)"
            >
              <template v-if="item.children?.length">
                <button
                  type="button"
                  class="nav-link w-full"
                  :class="{ 'nav-link-active': isActive(item) && (rail || !isGroupExpanded(item)), 'nav-link-rail': rail }"
                  :aria-label="rail ? item.label : undefined"
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
                <Transition name="collapse">
                  <div v-if="!rail && isGroupExpanded(item)">
                    <ul class="ml-[1.35rem] space-y-0.5 border-l border-line/80 py-1 pl-2">
                      <li v-for="(child, ci) in item.children" :key="child.to" class="nav-child" :style="{ '--i': ci }">
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
                  </div>
                </Transition>
              </template>
              <a
                v-else-if="item.href"
                :href="item.href"
                target="_blank"
                rel="noopener noreferrer"
                class="nav-link"
                :class="{ 'nav-link-rail': rail }"
                :aria-label="rail ? item.label : undefined"
              >
                <UiIcon :name="item.icon" :size="18" />
                <span class="fade-x truncate" :class="{ 'fade-x-hidden': rail }">{{ item.label }}</span>
              </a>
              <RouterLink
                v-else
                :to="item.to"
                class="nav-link relative"
                :class="{ 'nav-link-active': isActive(item), 'nav-link-rail': rail }"
                :aria-label="rail ? item.label : undefined"
                :aria-current="isActive(item) ? 'page' : undefined"
              >
                <UiIcon :name="item.icon" :size="18" />
                <span class="fade-x flex min-w-0 flex-1 items-center justify-between gap-2" :class="{ 'fade-x-hidden': rail }">
                  <span class="truncate">{{ item.label }}</span>
                  <span
                    v-if="item.badgeDot"
                    class="h-2 w-2 shrink-0 rounded-full"
                    :class="item.badgeTone === 'warning' ? 'bg-warning' : 'bg-accent'"
                  />
                </span>
                <span
                  v-if="rail && item.badgeDot"
                  class="absolute right-2.5 top-2.5 h-2 w-2 rounded-full ring-2 ring-surface"
                  :class="item.badgeTone === 'warning' ? 'bg-warning' : 'bg-accent'"
                />
              </RouterLink>
            </li>
          </ul>
        </div>
      </nav>

      <!-- Rail flyout: item name, or a group's pages -->
      <Transition name="flyout">
        <div
          v-if="rail && flyout"
          class="absolute left-full z-50 ml-2"
          :style="{ top: `${flyout.top + (flyout.item.children?.length ? -6 : 4)}px` }"
          @mouseenter="keepFlyout"
          @mouseleave="hideFlyout()"
        >
          <div v-if="flyout.item.children?.length" class="min-w-[11rem] rounded-xl border border-line bg-surface p-1.5 shadow-pop">
            <p class="px-2.5 pb-1 pt-1 text-2xs font-semibold tracking-wide text-fg-subtle">{{ flyout.item.label }}</p>
            <RouterLink
              v-for="child in flyout.item.children"
              :key="child.to"
              :to="child.to"
              class="nav-link nav-link-child"
              :class="{ 'nav-link-active': isActive(child) }"
              :aria-current="isActive(child) ? 'page' : undefined"
            >
              <UiIcon :name="child.icon" :size="15" />
              <span class="truncate">{{ child.label }}</span>
            </RouterLink>
          </div>
          <span v-else class="flyout-tip relative block whitespace-nowrap rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium text-surface shadow-pop">
            {{ flyout.item.label }}
          </span>
        </div>
      </Transition>

      <div class="flex shrink-0 gap-1.5 border-t border-line/70 p-3" :class="rail ? 'flex-col items-center' : 'items-center'">
        <ThemeSwitcher v-if="!rail" labels class="flex-1" />
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
      <header
        class="glass sticky top-0 z-30 border-b transition-[border-color,box-shadow,background-color] duration-300"
        :class="scrolled ? 'border-line/80 shadow-[0_8px_24px_-18px_rgb(var(--shadow)/0.35)]' : 'border-line/50 !bg-surface/60'"
      >
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
              <img v-if="logoUrl" :src="logoUrl" alt="" class="h-7 w-7 rounded-lg object-contain" />
              <BrandMark v-else :size="28" />
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
              <Transition name="text-swap" mode="out-in">
                <span :key="pageTitle" class="truncate font-semibold tracking-tight text-fg">{{ pageTitle }}</span>
              </Transition>
            </nav>
          </div>

          <div class="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            <LocaleSwitcher />
            <AnnouncementBell />
            <RouterLink
              v-if="balance"
              to="/dashboard"
              class="group hidden items-center gap-2 rounded-lg bg-accent/10 px-2.5 py-1.5 text-accent ring-1 ring-inset ring-accent/20 transition-[background-color,box-shadow] duration-200 hover:bg-accent/15 hover:shadow-glow-sm sm:inline-flex"
              :title="t('shell.balance')"
            >
              <UiIcon name="wallet" :size="15" class="transition-transform duration-300 ease-spring group-hover:-rotate-12 group-hover:scale-110" />
              <AnimatedNumber :value="balance" :from-zero="false" class="font-mono text-sm font-semibold" />
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
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-hover text-xs font-semibold text-accent-fg ring-2 ring-surface transition-shadow duration-200"
                  :class="menuOpen ? 'shadow-glow-sm' : ''"
                >
                  {{ initials }}
                </span>
                <span class="hidden min-w-0 max-w-[12rem] text-left leading-tight md:block">
                  <span class="block truncate text-sm font-medium text-fg">{{ displayName }}</span>
                  <span class="block text-2xs text-fg-subtle">{{ roleLabel }}</span>
                </span>
                <UiIcon
                  name="chevron-down"
                  :size="14"
                  class="hidden text-fg-subtle transition-transform duration-200 md:block"
                  :class="{ 'rotate-180': menuOpen }"
                />
              </button>

              <Transition name="menu">
              <div
                v-if="menuOpen"
                class="menu-panel absolute right-0 top-full mt-2 w-64 origin-top-right"
                role="menu"
              >
                <div class="flex items-center gap-3 px-2.5 pb-3 pt-2">
                  <span
                    class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent"
                  >
                    {{ initials }}
                  </span>
                  <div class="min-w-0 leading-tight">
                    <p class="truncate text-sm font-medium text-fg" :title="email">{{ displayName }}</p>
                    <p v-if="displayName !== email" class="truncate text-2xs text-fg-subtle">{{ email }}</p>
                    <p class="mt-0.5 text-2xs text-fg-subtle">{{ roleLabel }}</p>
                  </div>
                </div>
                <div v-if="balance" class="mx-1 mb-1 flex items-center justify-between rounded-lg bg-surface-2 px-2.5 py-2 sm:hidden">
                  <span class="text-xs text-fg-subtle">{{ t("shell.balance") }}</span>
                  <span class="font-mono text-sm font-semibold tabular-nums text-accent">{{ balance }}</span>
                </div>
                <div class="border-t border-line/70 py-1">
                  <RouterLink to="/profile" class="menu-item" role="menuitem">
                    <UiIcon name="user" :size="15" />
                    {{ t("shell.profile") }}
                  </RouterLink>
                  <RouterLink to="/keys" class="menu-item" role="menuitem">
                    <UiIcon name="key" :size="15" />
                    {{ t("nav.keys") }}
                  </RouterLink>
                  <RouterLink to="/dashboard" class="menu-item" role="menuitem">
                    <UiIcon name="gauge" :size="15" />
                    {{ t("nav.myDashboard") }}
                  </RouterLink>
                  <RouterLink v-if="auth.hasAdminAccess" :to="auth.isAdmin ? '/admin' : '/admin/groups'" class="menu-item" role="menuitem">
                    <UiIcon name="dashboard" :size="15" />
                    {{ t("nav.sections.admin") }}
                  </RouterLink>
                </div>
                <div class="border-t border-line/70 pt-1">
                  <button type="button" class="menu-item hover:!bg-danger/10 hover:!text-danger" role="menuitem" @click="handleLogout">
                    <UiIcon name="logout" :size="15" />
                    {{ t("shell.logout") }}
                  </button>
                </div>
              </div>
              </Transition>
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
.nav-link {
  transition-property: color, background-color, transform;
}
.nav-link:active {
  transform: scale(0.98);
}
.nav-link > svg {
  @apply text-fg-subtle;
  transition:
    color 150ms ease,
    transform 300ms var(--ease-spring);
}
.nav-link:hover > svg {
  @apply text-fg-muted;
  transform: translateX(1px) scale(1.08);
}
.nav-link-rail:hover > svg {
  transform: scale(1.12);
}
/* Children of a group cascade in as it expands. */
.collapse-enter-active .nav-child {
  animation: nav-child-in 320ms var(--ease-out) backwards;
  animation-delay: calc(var(--i, 0) * 35ms + 40ms);
}
@keyframes nav-child-in {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
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

.flyout-tip::before {
  content: "";
  @apply absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 rounded-[1px] bg-fg;
}
.flyout-enter-active {
  transition:
    opacity 140ms ease,
    transform 260ms var(--ease-spring-soft);
}
.flyout-leave-active {
  transition:
    opacity 100ms ease,
    transform 100ms ease;
}
.flyout-enter-from,
.flyout-leave-to {
  opacity: 0;
  transform: translateX(-6px) scale(0.96);
}

@keyframes nav-indicator-in {
  from {
    opacity: 0;
    transform: scaleY(0.3);
  }
}
</style>
