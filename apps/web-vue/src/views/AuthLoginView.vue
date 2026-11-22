<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { AuthSessionResponse } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import { useAuthStore } from "../stores/auth";

const { t } = useI18n();
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
      errorMessage.value = data.message ?? data.error ?? t("auth.failed");
      return;
    }
    auth.setSession(data);
    await auth.hydrateSession();
    await router.push(data.user.role === "admin" ? "/admin" : "/user");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("common.networkError");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthLayout :site-name="auth.setupStatus?.siteName">
    <h1 class="text-center text-xl font-semibold tracking-tight text-fg">
      {{ mode === "login" ? t("auth.loginTitle") : t("auth.registerTitle") }}
    </h1>

    <SegmentedControl
      v-if="canRegister"
      v-model="mode"
      class="mt-6"
      block
      size="md"
:options="[
        { value: 'login', label: t('auth.login') },
        { value: 'register', label: t('auth.register') },
      ]"
    />

    <form class="mt-6 space-y-4" @submit.prevent="handleSubmit">
      <label class="block">
        <span class="label">{{ t("auth.email") }}</span>
        <input
          v-model="email"
          type="email"
          required
          autocomplete="email"
          :placeholder="t('auth.emailPlaceholder')"
          class="input h-10"
        />
      </label>

      <label class="block">
        <span class="label">{{ t("auth.password") }}</span>
        <span class="relative block">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            :minlength="mode === 'register' ? 8 : 1"
            required
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            :placeholder="mode === 'login' ? t('auth.passwordPlaceholder') : t('auth.newPasswordPlaceholder')"
            class="input h-10 pr-10"
          />
          <button
            type="button"
            class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
            :aria-label="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
            @click="showPassword = !showPassword"
          >
            <UiIcon :name="showPassword ? 'eye-off' : 'eye'" :size="16" />
          </button>
        </span>
      </label>

      <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

      <button type="submit" :disabled="submitting" class="btn btn-primary h-10 w-full">
        <UiIcon v-if="submitting" name="loader" :size="16" spin />
        {{ submitting ? t("common.submitting") : mode === "login" ? t("auth.submitLogin") : t("auth.submitRegister") }}
      </button>
    </form>

    <p v-if="!canRegister" class="mt-6 text-center text-xs text-fg-muted">
      {{ t("auth.registrationClosed") }}
    </p>
  </AuthLayout>
</template>
