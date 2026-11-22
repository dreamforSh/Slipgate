import { createRouter, createWebHistory } from "vue-router";
import { i18n } from "../i18n";
import { useAuthStore } from "../stores/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/user" },
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
      path: "/admin",
      name: "admin-dashboard",
      component: () => import("../portals/admin/AdminDashboardView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, titleKey: "nav.dashboard" },
    },
    {
      path: "/admin/groups",
      name: "admin-groups",
      component: () => import("../portals/admin/AdminGroupsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, titleKey: "nav.groups" },
    },
    {
      path: "/admin/accounts",
      name: "admin-accounts",
      component: () => import("../portals/admin/AdminAccountsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, titleKey: "nav.accounts" },
    },
    {
      path: "/admin/clash",
      name: "admin-clash",
      component: () => import("../portals/admin/AdminClashPoolView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, titleKey: "nav.clash" },
    },
    {
      path: "/admin/vms",
      name: "admin-vms",
      component: () => import("../portals/admin/AdminVmFleetView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, titleKey: "nav.vms" },
    },
    {
      path: "/user",
      name: "user-console",
      component: () => import("../portals/user/UserConsoleView.vue"),
      meta: { requiresAuth: true, titleKey: "nav.keys" },
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const setup = await auth.fetchSetupStatus();

  if (setup && !setup.initialized) {
    if (to.path !== "/setup") {
      return "/setup";
    }
    return true;
  }

  if (to.path === "/setup") {
    return auth.isAuthenticated ? (auth.isAdmin ? "/admin" : "/user") : "/login";
  }

  if (!auth.hydrated) {
    await auth.hydrateSession();
  }

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return "/login";
  }

  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return "/user";
  }

  return true;
});

/** Keep the tab title in sync with the route and the active locale. */
export function syncDocumentTitle() {
  const auth = useAuthStore();
  const site = auth.setupStatus?.siteName || "Slipgate";
  const key = router.currentRoute.value.meta.titleKey;
  document.title = key ? `${i18n.global.t(key)} · ${site}` : site;
}

router.afterEach(() => syncDocumentTitle());

export default router;
