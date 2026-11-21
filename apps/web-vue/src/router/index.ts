import { createRouter, createWebHistory } from "vue-router";
import AdminAccountsView from "../portals/admin/AdminAccountsView.vue";
import AdminClashPoolView from "../portals/admin/AdminClashPoolView.vue";
import AdminDashboardView from "../portals/admin/AdminDashboardView.vue";
import AdminVmFleetView from "../portals/admin/AdminVmFleetView.vue";
import UserConsoleView from "../portals/user/UserConsoleView.vue";
import { useAuthStore } from "../stores/auth";
import AuthLoginView from "../views/AuthLoginView.vue";
import SetupWizardView from "../views/SetupWizardView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/user" },
    { path: "/setup", name: "setup-wizard", component: SetupWizardView },
    { path: "/login", name: "auth-login", component: AuthLoginView },
    {
      path: "/admin",
      name: "admin-dashboard",
      component: AdminDashboardView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/accounts",
      name: "admin-accounts",
      component: AdminAccountsView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/clash",
      name: "admin-clash",
      component: AdminClashPoolView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/vms",
      name: "admin-vms",
      component: AdminVmFleetView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/user",
      name: "user-console",
      component: UserConsoleView,
      meta: { requiresAuth: true },
    },
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

export default router;
