<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from "vue-router";
import { useAuthStore } from "./stores/auth";

const auth = useAuthStore();
const router = useRouter();

async function handleLogout() {
  auth.logout();
  await router.push("/login");
}
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <header class="border-b border-slate-800 bg-slate-900/70 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div class="flex items-center gap-3">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 font-mono text-sm font-bold text-sky-400">
            SG
          </span>
          <div>
            <h1 class="text-base font-semibold tracking-tight text-white">
              {{ auth.setupStatus?.siteName || "Slipgate Gateway" }}
            </h1>
            <p class="text-xs text-slate-400">Go Net · Zig Core · Bun BFF · Vue 3</p>
          </div>
        </div>

        <nav class="flex items-center gap-2 text-sm">
          <template v-if="auth.isAuthenticated">
            <RouterLink
              v-if="auth.isAdmin"
              to="/admin"
              class="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
              active-class="bg-sky-500/20 text-sky-300"
            >
              系统看板
            </RouterLink>
            <RouterLink
              v-if="auth.isAdmin"
              to="/admin/accounts"
              class="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
              active-class="bg-sky-500/20 text-sky-300"
            >
              号池与分组
            </RouterLink>
            <RouterLink
              to="/user"
              class="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
              active-class="bg-sky-500/20 text-sky-300"
            >
              密钥与配额
            </RouterLink>
            <span class="ml-2 rounded-md bg-slate-800 px-2.5 py-1 font-mono text-xs text-slate-300">
              {{ auth.user?.email }}
            </span>
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
              @click="handleLogout"
            >
              退出
            </button>
          </template>
          <RouterLink
            v-else
            to="/login"
            class="rounded-lg bg-sky-500/15 px-3 py-1.5 text-sky-300 hover:bg-sky-500/25"
          >
            登录
          </RouterLink>
        </nav>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-6 py-8">
      <RouterView />
    </main>
  </div>
</template>
