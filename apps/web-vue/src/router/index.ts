import { createRouter, createWebHistory } from "vue-router";
import AdminDashboardView from "../portals/admin/AdminDashboardView.vue";
import UserConsoleView from "../portals/user/UserConsoleView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/admin" },
    { path: "/admin", name: "admin-dashboard", component: AdminDashboardView },
    { path: "/user", name: "user-console", component: UserConsoleView },
  ],
});

export default router;
