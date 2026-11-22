<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import type { AuthSessionResponse } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import UiSwitch from "../components/ui/UiSwitch.vue";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();

const siteName = ref("Slipgate Gateway");
const adminEmail = ref("");
const adminPassword = ref("");
const showPassword = ref(false);
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
  <AuthLayout :site-name="siteName">
    <div>
      <span class="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-2xs font-medium text-accent">
        <UiIcon name="sparkles" :size="12" />
        首次运行
      </span>
      <h1 class="mt-3 text-2xl font-semibold tracking-tight text-fg">初始化网关</h1>
      <p class="mt-1.5 text-sm text-fg-muted">创建首位管理员并生成默认路由分组。此操作只能执行一次。</p>
    </div>

    <form class="mt-7 space-y-5" @submit.prevent="handleInitialize">
      <div class="space-y-4">
        <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">站点</p>
        <label class="block">
          <span class="label">站点名称</span>
          <input v-model="siteName" type="text" required class="input h-10" />
        </label>
      </div>

      <div class="space-y-4 border-t border-line pt-5">
        <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">管理员账号</p>
        <label class="block">
          <span class="label">邮箱</span>
          <input
            v-model="adminEmail"
            type="email"
            required
            autocomplete="email"
            placeholder="admin@example.com"
            class="input h-10"
          />
        </label>
        <label class="block">
          <span class="label flex items-center justify-between">
            密码
            <span class="font-normal text-fg-subtle">至少 8 位</span>
          </span>
          <span class="relative block">
            <input
              v-model="adminPassword"
              :type="showPassword ? 'text' : 'password'"
              minlength="8"
              required
              autocomplete="new-password"
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
      </div>

      <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/50 px-3.5 py-3">
        <div>
          <p class="text-sm font-medium text-fg">开放自助注册</p>
          <p class="mt-0.5 text-xs text-fg-subtle">允许普通用户在登录页自行注册账号</p>
        </div>
        <UiSwitch v-model="allowRegistration" label="开放自助注册" hide-label />
      </div>

      <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

      <button type="submit" :disabled="submitting" class="btn btn-primary h-10 w-full">
        <UiIcon v-if="submitting" name="loader" :size="16" spin />
        {{ submitting ? "初始化中…" : "创建管理员并进入控制台" }}
        <UiIcon v-if="!submitting" name="arrow-right" :size="15" />
      </button>
    </form>
  </AuthLayout>
</template>
