<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { AuthSessionResponse } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();

const mode = ref<"login" | "register">("login");
const email = ref("");
const password = ref("");
const showPassword = ref(false);
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
  <AuthLayout :site-name="auth.setupStatus?.siteName">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight text-fg">
        {{ mode === "login" ? "登录控制台" : "创建账号" }}
      </h1>
      <p class="mt-1.5 text-sm text-fg-muted">
        {{ mode === "login" ? "使用邮箱和密码登录。" : "注册后即可签发 API Key 并查看用量。" }}
      </p>
    </div>

    <SegmentedControl
      v-if="canRegister"
      v-model="mode"
      class="mt-6"
      block
      size="md"
      :options="[
        { value: 'login', label: '登录' },
        { value: 'register', label: '注册' },
      ]"
    />

    <form class="mt-6 space-y-4" @submit.prevent="handleSubmit">
      <label class="block">
        <span class="label">邮箱</span>
        <input
          v-model="email"
          type="email"
          required
          autocomplete="email"
          placeholder="user@example.com"
          class="input h-10"
        />
      </label>

      <label class="block">
        <span class="label flex items-center justify-between">
          密码
          <span v-if="mode === 'register'" class="font-normal text-fg-subtle">至少 8 位</span>
        </span>
        <span class="relative block">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            :minlength="mode === 'register' ? 8 : 1"
            required
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            class="input h-10 pr-10"
          />
          <button
            type="button"
            class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            @click="showPassword = !showPassword"
          >
            <UiIcon :name="showPassword ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </span>
      </label>

      <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

      <button type="submit" :disabled="submitting" class="btn btn-primary h-10 w-full">
        <UiIcon v-if="submitting" name="loader" :size="16" spin />
        {{ submitting ? "提交中…" : mode === "login" ? "登录" : "注册并登录" }}
      </button>
    </form>

    <p v-if="!canRegister" class="mt-6 text-center text-xs text-fg-subtle">
      本站已关闭自助注册，如需账号请联系管理员。
    </p>
  </AuthLayout>
</template>
