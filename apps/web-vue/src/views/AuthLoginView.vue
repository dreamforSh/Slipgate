<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { AuthSessionResponse } from "@slipgate/contracts";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();

const mode = ref<"login" | "register">("login");
const email = ref("");
const password = ref("");
const submitting = ref(false);
const errorMessage = ref<string | null>(null);

const canRegister = computed(() => auth.setupStatus?.allowRegistration ?? true);

async function handleSubmit() {
  errorMessage.value = null;
  submitting.value = true;
  const endpoint = mode.value === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.value,
        password: password.value,
      }),
    });
    const data = (await res.json()) as AuthSessionResponse & { message?: string; error?: string };
    if (!res.ok) {
      errorMessage.value = data.message ?? data.error ?? "认证失败";
      return;
    }
    auth.setSession(data);
    await auth.hydrateSession();
    await router.push(data.user.role === "admin" ? "/admin" : "/user");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "网络请求失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold text-white">
        {{ mode === "login" ? "登录 Slipgate" : "注册账号" }}
      </h2>
      <div v-if="canRegister" class="flex gap-1 rounded-lg bg-slate-950 p-1 text-xs">
        <button
          type="button"
          class="rounded px-2.5 py-1 transition"
          :class="mode === 'login' ? 'bg-sky-500 text-slate-950 font-semibold' : 'text-slate-400'"
          @click="mode = 'login'"
        >
          登录
        </button>
        <button
          type="button"
          class="rounded px-2.5 py-1 transition"
          :class="mode === 'register' ? 'bg-sky-500 text-slate-950 font-semibold' : 'text-slate-400'"
          @click="mode = 'register'"
        >
          注册
        </button>
      </div>
    </div>

    <form class="mt-6 space-y-4" @submit.prevent="handleSubmit">
      <div>
        <label class="block text-xs font-medium text-slate-300">邮箱</label>
        <input
          v-model="email"
          type="email"
          required
          placeholder="user@example.com"
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
        />
      </div>

      <div>
        <label class="block text-xs font-medium text-slate-300">密码</label>
        <input
          v-model="password"
          type="password"
          :minlength="mode === 'register' ? 8 : 1"
          required
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
        />
      </div>

      <p v-if="errorMessage" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
        {{ errorMessage }}
      </p>

      <button
        type="submit"
        :disabled="submitting"
        class="w-full rounded-lg bg-sky-500 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
      >
        {{ submitting ? "提交中..." : mode === "login" ? "立即登录" : "注册并登录" }}
      </button>
    </form>
  </div>
</template>
