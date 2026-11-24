import { createRouter, createWebHistory, type RouteComponent, type RouteRecordRaw } from "vue-router";

/** Lazily imported page component. */
type LazyPage = () => Promise<RouteComponent | { default: RouteComponent }>;
import { i18n } from "../i18n";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";

const admin = (path: string, name: string, load: LazyPage, titleKey: string, allowGroupManager = false): RouteRecordRaw => ({
  path,
  name,
  component: load,
  meta: { requiresAuth: true, requiresAdmin: true, allowGroupManager, titleKey },
});

const member = (path: string, name: string, load: LazyPage, titleKey: string): RouteRecordRaw => ({
  path,
  name,
  component: load,
  meta: { requiresAuth: true, titleKey },
});

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
  routes: [
    /* ---------- Public ---------- */
    { path: "/", name: "root", redirect: "/home" },
    {
      path: "/home",
      name: "home",
      component: () => import("../views/public/HomeView.vue"),
      meta: { layout: "public", titleKey: "publicNav.home" },
    },
    {
      path: "/models",
      name: "model-plaza",
      component: () => import("../views/public/ModelPlazaView.vue"),
      meta: { layout: "public", titleKey: "publicNav.models" },
    },
    {
      path: "/status",
      name: "status",
      component: () => import("../views/public/StatusView.vue"),
      meta: { layout: "public", titleKey: "publicNav.status" },
    },
    {
      path: "/key-usage",
      name: "key-usage",
      component: () => import("../views/public/KeyUsageView.vue"),
      meta: { layout: "public", titleKey: "publicNav.keyUsage" },
    },
    {
      path: "/legal/:documentId",
      name: "legal-document",
      component: () => import("../views/public/LegalDocumentView.vue"),
      meta: { layout: "public", titleKey: "authGuards.legal.title" },
    },
    {
      path: "/p/:slug",
      name: "site-page",
      component: () => import("../views/public/SitePageView.vue"),
      meta: { layout: "public", titleKey: "publicNav.page" },
    },
    {
      path: "/setup",
      name: "setup-wizard",
      component: () => import("../views/SetupWizardView.vue"),
      meta: { layout: "auth", titleKey: "setup.title" },
    },
    {
      path: "/login",
      name: "auth-login",
      component: () => import("../views/AuthLoginView.vue"),
      meta: { layout: "auth", titleKey: "auth.login" },
    },
    {
      path: "/forgot-password",
      name: "forgot-password",
      component: () => import("../views/ForgotPasswordView.vue"),
      meta: { layout: "auth", titleKey: "register.forgot.title" },
    },
    {
      path: "/reset-password",
      name: "reset-password",
      component: () => import("../views/ResetPasswordView.vue"),
      meta: { layout: "auth", titleKey: "register.reset.title" },
    },
    {
      path: "/oauth/complete",
      name: "oauth-complete",
      component: () => import("../views/OAuthCompleteView.vue"),
      meta: { layout: "auth", titleKey: "register.oauth.completing" },
    },
    { path: "/register", redirect: (to) => ({ path: "/login", query: { ...to.query, mode: "register" } }) },

    /* ---------- Admin ---------- */
    admin("/admin", "admin-dashboard", () => import("../portals/admin/AdminDashboardView.vue"), "nav.dashboard"),
    admin("/admin/ops", "admin-ops", () => import("../portals/admin/AdminOpsView.vue"), "nav.ops"),
    admin("/admin/risk", "admin-risk", () => import("../portals/admin/AdminRiskView.vue"), "nav.risk"),
    admin("/admin/usage", "admin-usage", () => import("../portals/admin/AdminUsageView.vue"), "nav.adminUsage", true),
    admin("/admin/users", "admin-users", () => import("../portals/admin/AdminUsersView.vue"), "nav.users", true),
    admin("/admin/groups", "admin-groups", () => import("../portals/admin/AdminGroupsView.vue"), "nav.groups", true),
    admin(
      "/admin/subscriptions",
      "admin-subscriptions",
      () => import("../portals/admin/AdminSubscriptionsView.vue"),
      "nav.subscriptions",
    ),
    admin("/admin/accounts", "admin-accounts", () => import("../portals/admin/AdminAccountsView.vue"), "nav.accounts", true),
    { path: "/admin/proxy", redirect: "/admin/proxy/clash" },
    admin("/admin/proxy/clash", "admin-proxy-clash", () => import("../portals/admin/AdminClashPoolView.vue"), "nav.proxyClash"),
    admin("/admin/proxy/ips", "admin-proxy-ips", () => import("../portals/admin/AdminProxyIpsView.vue"), "nav.proxyIps"),
    // The proxy pool used to live here; keep old bookmarks working.
    { path: "/admin/clash", redirect: "/admin/proxy/clash" },
    admin("/admin/pricing", "admin-pricing", () => import("../portals/admin/AdminPricingView.vue"), "nav.pricing"),
    admin("/admin/vms", "admin-vms", () => import("../portals/admin/AdminVmFleetView.vue"), "nav.vms"),
    admin(
      "/admin/announcements",
      "admin-announcements",
      () => import("../portals/admin/AdminAnnouncementsView.vue"),
      "nav.announcements",
    ),
    admin("/admin/redeem", "admin-redeem", () => import("../portals/admin/AdminRedeemView.vue"), "nav.redeem"),
    admin("/admin/promo-codes", "admin-promo", () => import("../portals/admin/AdminPromoCodesView.vue"), "nav.promoCodes"),
    admin("/admin/payments", "admin-payments", () => import("../portals/admin/AdminPaymentDashboardView.vue"), "nav.paymentDashboard"),
    admin("/admin/orders", "admin-orders", () => import("../portals/admin/AdminOrdersView.vue"), "nav.paymentOrders"),
    admin("/admin/payment-plans", "admin-payment-plans", () => import("../portals/admin/AdminPaymentPlansView.vue"), "nav.paymentPlans"),
    admin(
      "/admin/payment-settings",
      "admin-payment-settings",
      () => import("../portals/admin/AdminPaymentSettingsView.vue"),
      "nav.paymentSettings",
    ),
    admin("/admin/affiliates", "admin-affiliates", () => import("../portals/admin/AdminAffiliateRebatesView.vue"), "nav.affiliateRebates"),
    admin("/admin/plugins", "admin-plugins", () => import("../portals/admin/AdminPluginsView.vue"), "nav.plugins"),
    admin("/admin/backup", "admin-backup", () => import("../portals/admin/AdminBackupView.vue"), "nav.backup"),
    admin("/admin/monitor", "admin-monitor", () => import("../portals/admin/AdminChannelMonitorView.vue"), "nav.channelMonitor"),
    admin("/admin/audit-logs", "admin-audit", () => import("../portals/admin/AdminAuditLogsView.vue"), "nav.auditLogs"),
    admin("/admin/system-logs", "admin-system-logs", () => import("../portals/admin/AdminSystemLogsView.vue"), "systemLogs.title"),
    admin("/admin/settings", "admin-settings", () => import("../portals/admin/AdminSettingsView.vue"), "nav.settings"),

    /* ---------- Signed-in users ---------- */
    member("/dashboard", "user-dashboard", () => import("../portals/user/UserDashboardView.vue"), "nav.myDashboard"),
    member("/keys", "user-keys", () => import("../portals/user/UserConsoleView.vue"), "nav.keys"),
    { path: "/user", redirect: "/keys" },
    member("/usage", "user-usage", () => import("../portals/user/UserUsageView.vue"), "nav.myUsage"),
    member(
      "/subscriptions",
      "user-subscriptions",
      () => import("../portals/user/UserSubscriptionsView.vue"),
      "nav.mySubscriptions",
    ),
    member("/redeem", "user-redeem", () => import("../portals/user/UserRedeemView.vue"), "nav.myRedeem"),
    member("/affiliate", "user-affiliate", () => import("../portals/user/UserAffiliateView.vue"), "nav.affiliate"),
    member("/purchase", "user-purchase", () => import("../portals/user/UserPurchaseView.vue"), "nav.purchase"),
    member("/orders", "user-orders", () => import("../portals/user/UserOrdersView.vue"), "nav.orders"),
    {
      path: "/payment/result",
      name: "payment-result",
      component: () => import("../portals/user/PaymentResultView.vue"),
      // Provider return URLs carry a signed resume token: signed-out payers get the public status page.
      meta: { requiresAuth: true, titleKey: "nav.paymentResult", guestRedirect: "/payment/status" },
    },
    member("/payment/airwallex", "payment-airwallex", () => import("../portals/user/AirwallexCheckoutView.vue"), "payFlow.airwallex.title"),
    {
      path: "/payment/wechat/callback",
      name: "payment-wechat-callback",
      component: () => import("../views/WechatPaymentCallbackView.vue"),
      meta: { layout: "auth", requiresAuth: true, titleKey: "payFlow.wechat.title" },
    },
    {
      path: "/payment/status",
      name: "payment-status",
      component: () => import("../views/PaymentStatusView.vue"),
      meta: { layout: "auth", titleKey: "payFlow.publicStatus.title" },
    },
    member("/profile", "user-profile", () => import("../portals/user/UserProfileView.vue"), "nav.profile"),

    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

/**
 * Pages a visitor may open while backend (admin-only) mode is on: sign-in, the public legal
 * documents, key usage lookup and payment returns (Linksyncx parity); password reset stays for
 * administrators (the server only mails them).
 */
const BACKEND_MODE_PATHS = new Set(["/login", "/setup", "/key-usage", "/oauth/complete", "/forgot-password", "/reset-password"]);

function backendModeAllows(path: string): boolean {
  return BACKEND_MODE_PATHS.has(path) || path.startsWith("/legal/") || path.startsWith("/payment/");
}

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const portal = usePortalStore();
  const [setup] = await Promise.all([auth.fetchSetupStatus(), portal.load()]);

  if (setup && !setup.initialized) {
    return to.path === "/setup" ? true : "/setup";
  }

  if (!auth.hydrated) {
    await auth.hydrateSession();
  }

  if (to.path === "/setup") {
    return auth.isAuthenticated ? (auth.isAdmin ? "/admin" : auth.isGroupManager ? "/admin/groups" : "/dashboard") : "/login";
  }

  // Backend (admin-only) mode: anyone but an administrator only reaches sign-in and the few pages
  // that stay public (the server refuses everything else for them anyway).
  if (portal.settings?.backendModeEnabled && !auth.isAdmin) {
    if (auth.isAuthenticated) {
      auth.sessionNotice = "backend_mode";
      auth.logout();
    }
    if (!backendModeAllows(to.path)) return "/login";
  }

  // The landing page is for visitors; signed-in users go straight to their console.
  if (to.name === "home" && auth.isAuthenticated && !to.query.preview) {
    return auth.isAdmin ? "/admin" : auth.isGroupManager ? "/admin/groups" : "/dashboard";
  }

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    if (to.meta.guestRedirect && typeof to.query.token === "string" && to.query.token) {
      return { path: to.meta.guestRedirect, query: to.query };
    }
    return { path: "/login", query: to.fullPath !== "/" ? { redirect: to.fullPath } : {} };
  }

  if (to.meta.requiresAdmin && !auth.isAdmin && !(auth.isGroupManager && to.meta.allowGroupManager)) {
    return auth.isGroupManager ? "/admin/groups" : "/dashboard";
  }

  return true;
});

/** Keep the tab title in sync with the route and the active locale. */
export function syncDocumentTitle() {
  const portal = usePortalStore();
  const auth = useAuthStore();
  const site = portal.settings?.siteName || auth.setupStatus?.siteName || "Slipgate";
  const key = router.currentRoute.value.meta.titleKey;
  document.title = key ? `${i18n.global.t(key)} · ${site}` : site;
}

router.afterEach(() => syncDocumentTitle());

export default router;
