<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import BrandMark from "./BrandMark.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const mobileOpen = ref(false);

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  exact?: boolean;
}

const sections = computed<{ title: string; items: NavItem[] }[]>(() => {
  const out: { title: string; items: NavItem[] }[] = [];
  if (auth.isAdmin) {
    out.push({
      title: "运维管理",
      items: [
        { to: "/admin", label: "系统看板", icon: "dashboard", exact: true },
        { to: "/admin/accounts", label: "号池与分组", icon: "layers" },
        { to: "/admin/clash", label: "Clash 出口与 uTLS", icon: "globe" },
        { to: "/admin/vms", label: "VM 拟真槽舰队", icon: "server" },
      ],
    });
  }
  out.push({
    title: "我的账户",
    items: [{ to: "/user", label: "密钥与配额", icon: "key" }],
  });
  return out;
});

function isActive(item: NavItem) {
  return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`);
}

const siteName = computed(() => auth.setupStatus?.siteName || "Slipgate");
const initials = computed(() => (auth.user?.email ?? "?").slice(0, 1).toUpperCase());

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
  },
);

async function handleLogout() {
  auth.logout();
  await router.push("/login");
}
</script>

<template>
  <div class="min-h-screen">
    <!-- Mobile top bar -->
    <header
      class="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/85 px-4 backdrop-blur lg:hidden"
    >
      <div class="flex items-center gap-2.5">
        <button type="button" class="btn btn-ghost btn-icon btn-sm -ml-1.5" aria-label="打开导航" @click="mobileOpen = true">
          <UiIcon name="menu" :size="18" />
        </button>
        <BrandMark :size="24" />
        <span class="text-sm font-semibold text-fg">{{ siteName }}</span>
      </div>
      <ThemeSwitcher compact />
    </header>

    <!-- Mobile scrim -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="mobileOpen" class="fixed inset-0 z-40 bg-black/50 lg:hidden" @click="mobileOpen = false" />
    </Transition>

    <!-- Sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-surface transition-transform duration-300 ease-out lg:z-30 lg:w-60 lg:translate-x-0"
      :class="mobileOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full'"
      aria-label="主导航"
    >
      <div class="flex h-14 items-center justify-between gap-2.5 border-b border-line px-4 lg:h-16">
        <RouterLink :to="auth.isAdmin ? '/admin' : '/user'" class="flex min-w-0 items-center gap-2.5">
          <BrandMark :size="28" />
          <div class="min-w-0 leading-tight">
            <p class="truncate text-sm font-semibold text-fg">{{ siteName }}</p>
            <p class="truncate text-2xs text-fg-subtle">AI API 统一网关</p>
          </div>
        </RouterLink>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm lg:hidden"
          aria-label="关闭导航"
          @click="mobileOpen = false"
        >
          <UiIcon name="x" :size="16" />
        </button>
      </div>

      <nav class="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        <div v-for="section in sections" :key="section.title">
          <p class="mb-1.5 px-2.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">{{ section.title }}</p>
          <ul class="space-y-0.5">
            <li v-for="item in section.items" :key="item.to">
              <RouterLink
                :to="item.to"
                class="group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors duration-150"
                :class="
                  isActive(item)
                    ? 'bg-accent/10 font-medium text-accent'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                "
                :aria-current="isActive(item) ? 'page' : undefined"
              >
                <UiIcon :name="item.icon" :size="16" />
                <span class="truncate">{{ item.label }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </nav>

      <div class="space-y-3 border-t border-line p-3">
        <ThemeSwitcher />
        <div class="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          <span
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent"
          >
            {{ initials }}
          </span>
          <div class="min-w-0 flex-1 leading-tight">
            <p class="truncate text-xs font-medium text-fg" :title="auth.user?.email">{{ auth.user?.email }}</p>
            <p class="text-2xs text-fg-subtle">{{ auth.isAdmin ? "管理员" : "普通用户" }}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="退出登录" aria-label="退出登录" @click="handleLogout">
            <UiIcon name="logout" :size="15" />
          </button>
        </div>
      </div>
    </aside>

    <main class="lg:pl-60">
      <div class="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <slot />
      </div>
    </main>
  </div>
</template>
