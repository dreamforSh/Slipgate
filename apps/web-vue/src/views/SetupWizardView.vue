<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { AuthSessionResponse } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import UiSwitch from "../components/ui/UiSwitch.vue";
import { useAuthStore } from "../stores/auth";

const { t } = useI18n();
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
      errorMessage.value = data.message ?? data.error ?? t("setup.failed");
      return;
    }
    auth.setSession(data);
    await auth.fetchSetupStatus(true);
    await auth.hydrateSession();
    await router.push("/admin/accounts");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("common.networkError");
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
        {{ t("setup.badge") }}
      </span>
      <h1 class="mt-3 text-xl font-semibold tracking-tight text-fg">{{ t("setup.title") }}</h1>
    </div>

    <form class="mt-7 space-y-5" @submit.prevent="handleInitialize">
      <div class="space-y-4">
        <p class="eyebrow">{{ t("setup.site") }}</p>
        <label class="block">
          <span class="label">{{ t("setup.siteName") }}</span>
          <input v-model="siteName" type="text" required class="input h-10" />
        </label>
      </div>

      <div class="space-y-4 border-t border-line pt-5">
        <p class="eyebrow">{{ t("setup.admin") }}</p>
        <label class="block">
          <span class="label">{{ t("auth.email") }}</span>
          <input
            v-model="adminEmail"
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
              v-model="adminPassword"
              :type="showPassword ? 'text' : 'password'"
              minlength="8"
              required
              autocomplete="new-password"
              :placeholder="t('auth.newPasswordPlaceholder')"
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
      </div>

      <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/50 px-3.5 py-3">
        <p class="text-sm font-medium text-fg">{{ t("setup.allowRegistration") }}</p>
        <UiSwitch v-model="allowRegistration" :label="t('setup.allowRegistration')" hide-label />
      </div>

      <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

      <button type="submit" :disabled="submitting" class="btn btn-primary h-10 w-full">
        <UiIcon v-if="submitting" name="loader" :size="16" spin />
        {{ submitting ? t("setup.submitting") : t("setup.submit") }}
        <UiIcon v-if="!submitting" name="arrow-right" :size="15" />
      </button>
    </form>
  </AuthLayout>
</template>
