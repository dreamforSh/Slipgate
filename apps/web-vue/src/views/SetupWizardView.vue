<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import type { AuthSessionResponse } from "@slipgate/contracts";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();

const siteName = ref("Slipgate Gateway");
const adminEmail = ref("");
const adminPassword = ref("");
const allowRegistration = ref(true);
const submitting = ref(false);
const errorMessage = ref<string | null>(null);

async function handleInitialize() {
  errorMessage.value = null;
  submitting.value = true;
  try {
    const res = await fetch("/api/v1/setup/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteName: siteName.value,
        adminEmail: adminEmail.value,
        adminPassword: adminPassword.value,
        allowRegistration: allowRegistration.value,
      }),
    });
    const data = (await res.json()) as AuthSessionResponse & { message?: string; error?: string };
    if (!res.ok) {
      errorMessage.value = data.message ?? data.error ?? "初始化失败";
      return;
    }
    auth.setSession(data);
    await auth.fetchSetupStatus(true);
    await auth.hydrateSession();
    await router.push("/admin/accounts");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "网络请求失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl">
    <h2 class="text-xl font-bold text-white">首次运行初始化向导</h2>
    <p class="mt-2 text-sm text-slate-400">
      创建 Slipgate 首位管理员账号并初始化默认路由分组（仅可执行一次）。
    </p>

    <form class="mt-6 space-y-4" @submit.prevent="handleInitialize">
      <div>
        <label class="block text-xs font-medium text-slate-300">站点名称</label>
        <input
          v-model="siteName"
          type="text"
          required
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
        />
      </div>

      <div>
        <label class="block text-xs font-medium text-slate-300">管理员邮箱</label>
        <input
          v-model="adminEmail"
          type="email"
          required
          placeholder="admin@example.com"
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
        />
      </div>

      <div>
        <label class="block text-xs font-medium text-slate-300">管理员密码（至少 8 位）</label>
        <input
          v-model="adminPassword"
          type="password"
          minlength="8"
          required
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
        />
      </div>

      <label class="flex items-center gap-2 text-sm text-slate-300">
        <input v-model="allowRegistration" type="checkbox" class="rounded border-slate-700 bg-slate-950" />
        开放普通用户自助注册
      </label>

      <p v-if="errorMessage" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
        {{ errorMessage }}
      </p>

      <button
        type="submit"
        :disabled="submitting"
        class="w-full rounded-lg bg-sky-500 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
      >
        {{ submitting ? "初始化中..." : "创建管理员并进入控制台" }}
      </button>
    </form>
  </div>
</template>
