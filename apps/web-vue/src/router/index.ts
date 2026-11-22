import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/user" },
    {
      path: "/setup",
      name: "setup-wizard",
      component: () => import("../views/SetupWizardView.vue"),
      meta: { layout: "auth", title: "初始化" },
    },
    {
      path: "/login",
      name: "auth-login",
      component: () => import("../views/AuthLoginView.vue"),
      meta: { layout: "auth", title: "登录" },
    },
    {
      path: "/admin",
      name: "admin-dashboard",
      component: () => import("../portals/admin/AdminDashboardView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, title: "系统看板" },
    },
    {
      path: "/admin/accounts",
      name: "admin-accounts",
      component: () => import("../portals/admin/AdminAccountsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, title: "号池与分组" },
    },
    {
      path: "/admin/clash",
      name: "admin-clash",
      component: () => import("../portals/admin/AdminClashPoolView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, title: "Clash 出口与 uTLS" },
    },
    {
      path: "/admin/vms",
      name: "admin-vms",
      component: () => import("../portals/admin/AdminVmFleetView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true, title: "VM 拟真槽舰队" },
    },
    {
      path: "/user",
      name: "user-console",
      component: () => import("../portals/user/UserConsoleView.vue"),
      meta: { requiresAuth: true, title: "密钥与配额" },
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

router.afterEach((to) => {
  const auth = useAuthStore();
  const site = auth.setupStatus?.siteName || "Slipgate";
  document.title = to.meta.title ? `${to.meta.title} · ${site}` : site;
});

export default router;
