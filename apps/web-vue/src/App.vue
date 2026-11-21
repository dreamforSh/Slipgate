<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
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
            <h1 class="text-base font-semibold tracking-tight text-white">Slipgate Gateway</h1>
            <p class="text-xs text-slate-400">Go Net · Zig Core · Bun BFF · Vue 3</p>
          </div>
        </div>
        <nav class="flex items-center gap-2 text-sm">
          <RouterLink
            to="/admin"
            class="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
            active-class="bg-sky-500/20 text-sky-300"
          >
            管理后台
          </RouterLink>
          <RouterLink
            to="/user"
            class="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
            active-class="bg-sky-500/20 text-sky-300"
          >
            用户工作台
          </RouterLink>
        </nav>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-6 py-8">
      <RouterView />
    </main>
  </div>
</template>
