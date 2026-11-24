<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { PasswordChangedResponse, UserProfile, WalletSummary } from "@slipgate/contracts";
import PasswordInput from "../../components/me/PasswordInput.vue";
import PasswordStrength from "../../components/me/PasswordStrength.vue";
import LinkedAccountsCard from "../../components/me/LinkedAccountsCard.vue";
import SessionsCard from "../../components/me/SessionsCard.vue";
import TotpCard from "../../components/me/TotpCard.vue";
import PasskeysPanel from "../../components/profile/PasskeysPanel.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { ApiError, apiJson, errorText } from "../../lib/api";
import { formatDateShort, formatRelative, formatUsd } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { usePortalStore } from "../../stores/portal";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const auth = useAuthStore();
const portal = usePortalStore();
const toast = useToastStore();

/* ---------------- Identity ---------------- */

const user = computed(() => auth.user);
const emailLocal = computed(() => (user.value?.email ?? "").split("@")[0] ?? "");
const displayName = computed(() => user.value?.username?.trim() || emailLocal.value || "—");
const initial = computed(() => Array.from(displayName.value)[0]?.toUpperCase() ?? "?");
const isPlaceholderEmail = computed(() => Boolean(user.value?.email?.toLowerCase().endsWith("@users.noreply.slipgate")));
const emailVerificationNeeded = computed(() => Boolean(portal.settings?.emailVerificationRequired));
const balance = computed(() =>
  auth.wallet ? auth.wallet.formattedAvailableUsd || formatUsd(auth.wallet.availableNanoUsd) : "—",
);

const avatarStyle = {
  backgroundImage: "linear-gradient(135deg, rgb(var(--accent-solid)) 0%, rgb(var(--accent-glow)) 100%)",
};

onMounted(async () => {
  // Refresh the wallet so the balance row is current (a failure just keeps the cached one).
  try {
    const res = await apiJson<{ wallet: WalletSummary }>("/api/v1/user/wallet");
    auth.wallet = res.wallet;
  } catch {
    // Keep whatever the session already loaded.
  }
});

/* ---------------- Display name & avatar ---------------- */

const nameDraft = ref(user.value?.username ?? "");
const avatarDraft = ref(user.value?.avatarUrl ?? "");
const savingName = ref(false);

watch(
  () => [user.value?.username, user.value?.avatarUrl] as const,
  ([nextName, nextAvatar]) => {
    if (!savingName.value) {
      nameDraft.value = nextName ?? "";
      avatarDraft.value = nextAvatar ?? "";
    }
  },
);

const nameChanged = computed(
  () => nameDraft.value.trim() !== (user.value?.username ?? "") || avatarDraft.value.trim() !== (user.value?.avatarUrl ?? ""),
);
const nameTooLong = computed(() => nameDraft.value.trim().length > 64);
const namePreview = computed(() => nameDraft.value.trim() || emailLocal.value);

async function saveName() {
  if (!nameChanged.value || nameTooLong.value || savingName.value) return;
  savingName.value = true;
  try {
    const res = await apiJson<{ user: UserProfile }>("/api/v1/user/profile", {
      method: "PATCH",
      body: { username: nameDraft.value.trim(), avatarUrl: avatarDraft.value.trim() },
    });
    auth.user = res.user;
    nameDraft.value = res.user.username;
    avatarDraft.value = res.user.avatarUrl ?? "";
    toast.success(t("profile.name.saved"));
  } catch (err) {
    toast.error(errorText(err, t("profile.name.failed")));
  } finally {
    savingName.value = false;
  }
}

/* ---------------- Bind real email (OAuth placeholder accounts) ---------------- */

const bindEmail = reactive({ address: "", code: "", sendingCode: false, saving: false, sentTo: "" });

async function sendBindEmailCode() {
  const email = bindEmail.address.trim();
  if (!email || bindEmail.sendingCode) return;
  bindEmail.sendingCode = true;
  try {
    await apiJson("/api/v1/user/profile/bind-email/code", {
      method: "POST",
      body: { email },
    });
    bindEmail.sentTo = email;
    toast.success(t("profile.bindEmail.codeSent"));
  } catch (err) {
    toast.error(errorText(err, t("profile.bindEmail.sendCodeFailed")));
  } finally {
    bindEmail.sendingCode = false;
  }
}

async function submitBindEmail() {
  const email = bindEmail.address.trim();
  if (!email || bindEmail.saving) return;
  bindEmail.saving = true;
  try {
    const res = await apiJson<{ user: UserProfile }>("/api/v1/user/profile/bind-email", {
      method: "POST",
      body: {
        email,
        ...(bindEmail.code.trim() ? { emailCode: bindEmail.code.trim() } : {}),
      },
    });
    auth.user = res.user;
    bindEmail.address = "";
    bindEmail.code = "";
    bindEmail.sentTo = "";
    toast.success(t("profile.bindEmail.saved"));
  } catch (err) {
    toast.error(errorText(err, t("profile.bindEmail.failed")));
  } finally {
    bindEmail.saving = false;
  }
}

/* ---------------- Password ---------------- */

const pw = reactive({ current: "", next: "", confirm: "" });
const savingPw = ref(false);
const currentError = ref<string | null>(null);

watch(
  () => pw.current,
  () => (currentError.value = null),
);

const nextError = computed(() => {
  if (!pw.next) return null;
  if (pw.next.length < 8) return t("profile.password.tooShort");
  if (pw.current && pw.next === pw.current) return t("profile.password.same");
  return null;
});
const confirmError = computed(() => (pw.confirm && pw.confirm !== pw.next ? t("profile.password.mismatch") : null));
const confirmOk = computed(() => Boolean(pw.confirm) && pw.confirm === pw.next && pw.next.length >= 8);
const canChange = computed(
  () => Boolean(pw.current) && pw.next.length >= 8 && pw.next === pw.confirm && pw.next !== pw.current && !savingPw.value,
);

async function changePassword() {
  if (!canChange.value) return;
  savingPw.value = true;
  currentError.value = null;
  try {
    const res = await apiJson<PasswordChangedResponse>("/api/v1/user/password", {
      method: "POST",
      body: { currentPassword: pw.current, newPassword: pw.next },
    });
    // Every other session ended with the old password; this one continues on the fresh token.
    if (res.session) auth.setSession(res.session);
    pw.current = "";
    pw.next = "";
    pw.confirm = "";
    toast.success(t("profile.password.changed"));
  } catch (err) {
    const message = errorText(err, t("profile.password.failed"));
    if (err instanceof ApiError && err.code === "forbidden") currentError.value = message;
    toast.error(message);
  } finally {
    savingPw.value = false;
  }
}

const stagger = (i: number) => ({ animationDelay: `${i * 70}ms`, animationFillMode: "both" });
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('profile.title')" />

    <div class="grid items-start gap-6 lg:grid-cols-3">
      <!-- Identity -->
      <section class="card animate-slide-up overflow-hidden motion-reduce:animate-none" :style="stagger(0)">
        <div class="relative h-24 bg-gradient-to-br from-accent/20 via-info/10 to-violet/10">
          <div class="absolute inset-0 bg-grid" />
        </div>
        <div class="relative -mt-10 px-5 pb-5">
          <img
            v-if="user?.avatarUrl"
            :src="user.avatarUrl"
            alt=""
            class="h-20 w-20 rounded-2xl bg-surface object-cover shadow-glow ring-4 ring-surface"
          />
          <span
            v-else
            class="inline-flex h-20 w-20 select-none items-center justify-center rounded-2xl text-3xl font-bold text-accent-fg shadow-glow ring-4 ring-surface"
            :style="avatarStyle"
            aria-hidden="true"
          >
            {{ initial }}
          </span>
          <h2 class="mt-3 truncate text-lg font-semibold text-fg">{{ displayName }}</h2>
          <p class="truncate text-sm text-fg-subtle">{{ user?.email }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <UiBadge :tone="user?.role === 'admin' ? 'violet' : 'accent'">
              <UiIcon :name="user?.role === 'admin' ? 'shield' : 'user'" :size="11" class="mr-0.5 inline" />
              {{ user ? t(`shell.roles.${user.role}`) : "—" }}
            </UiBadge>
            <UiBadge :tone="user?.status === 'active' ? 'success' : 'danger'" dot>
              {{ user ? t(`profile.status.${user.status}`) : "—" }}
            </UiBadge>
          </div>

          <dl class="mt-5 divide-y divide-line/70 border-t border-line/70 text-sm">
            <div class="flex items-center justify-between gap-3 py-3">
              <dt class="flex items-center gap-2 text-fg-subtle">
                <UiIcon name="mail" :size="14" />
                {{ t("profile.info.email") }}
              </dt>
              <dd class="min-w-0 truncate text-right font-medium text-fg">{{ user?.email }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3 py-3">
              <dt class="flex items-center gap-2 text-fg-subtle">
                <UiIcon name="calendar" :size="14" />
                {{ t("profile.info.memberSince") }}
              </dt>
              <dd class="text-right">
                <span class="font-medium text-fg">{{ formatDateShort(user?.createdAtIso) }}</span>
                <span class="ml-1.5 text-xs text-fg-subtle">{{ formatRelative(user?.createdAtIso) }}</span>
              </dd>
            </div>
            <div class="flex items-center justify-between gap-3 py-3">
              <dt class="flex items-center gap-2 text-fg-subtle">
                <UiIcon name="shield" :size="14" />
                {{ t("profile.info.twoFactor") }}
              </dt>
              <dd>
                <UiBadge :tone="user?.totpEnabled ? 'success' : 'neutral'">
                  {{ user?.totpEnabled ? t("profile.info.on") : t("profile.info.off") }}
                </UiBadge>
              </dd>
            </div>
            <div class="flex items-center justify-between gap-3 pt-3">
              <dt class="flex items-center gap-2 text-fg-subtle">
                <UiIcon name="wallet" :size="14" />
                {{ t("profile.info.balance") }}
              </dt>
              <dd>
                <RouterLink
                  to="/redeem"
                  class="group inline-flex items-center gap-1 font-mono font-semibold tabular-nums text-fg transition-colors hover:text-accent"
                  :title="t('profile.info.topUp')"
                >
                  {{ balance }}
                  <UiIcon name="chevron-right" :size="13" class="text-fg-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                </RouterLink>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <div class="space-y-6 lg:col-span-2">
        <!-- Display name -->
        <UiCard
          class="animate-slide-up motion-reduce:animate-none"
          :style="stagger(1)"
          icon="user"
          :title="t('profile.name.title')"
        >
          <form class="space-y-3" @submit.prevent="saveName">
            <label for="profile-name" class="label">{{ t("profile.name.label") }}</label>
            <div class="flex flex-col gap-2 sm:flex-row">
              <input
                id="profile-name"
                v-model="nameDraft"
                type="text"
                maxlength="64"
                autocomplete="nickname"
                class="input sm:flex-1"
                :class="nameTooLong ? '!border-danger/60' : ''"
                :placeholder="emailLocal"
              />
              <button type="submit" class="btn btn-primary shrink-0" :disabled="!nameChanged || nameTooLong || savingName">
                <UiIcon :name="savingName ? 'loader' : 'check'" :size="15" :spin="savingName" />
                {{ savingName ? t("common.saving") : t("common.save") }}
              </button>
            </div>
            <div>
              <label for="profile-avatar" class="label">{{ t("profile.avatar.label") }}</label>
              <input
                id="profile-avatar"
                v-model="avatarDraft"
                type="url"
                maxlength="512"
                class="input font-mono text-xs"
                :placeholder="t('profile.avatar.placeholder')"
              />
            </div>
            <p class="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
              <UiIcon name="info" :size="12" />
              {{ t("profile.name.hint") }}
              <span class="font-medium text-fg-muted">{{ t("profile.name.preview", { name: namePreview }) }}</span>
            </p>
          </form>
        </UiCard>

        <!-- Bind real email for placeholder OAuth accounts -->
        <UiCard
          v-if="isPlaceholderEmail"
          class="animate-slide-up motion-reduce:animate-none"
          :style="stagger(2)"
          icon="mail"
          :title="t('profile.bindEmail.title')"
        >
          <form class="space-y-3" @submit.prevent="submitBindEmail">
            <p class="text-sm text-fg-subtle">{{ t("profile.bindEmail.desc") }}</p>
            <div class="flex flex-col gap-2 sm:flex-row">
              <input
                v-model="bindEmail.address"
                type="email"
                required
                maxlength="254"
                class="input sm:flex-1"
                :placeholder="t('profile.bindEmail.placeholder')"
              />
              <button
                v-if="emailVerificationNeeded"
                type="button"
                class="btn btn-secondary shrink-0"
                :disabled="!bindEmail.address.trim() || bindEmail.sendingCode"
                @click="sendBindEmailCode"
              >
                <UiIcon v-if="bindEmail.sendingCode" name="loader" :size="14" spin />
                {{ t("profile.bindEmail.sendCode") }}
              </button>
            </div>
            <div v-if="emailVerificationNeeded || bindEmail.sentTo" class="flex flex-col gap-2 sm:flex-row">
              <input
                v-model="bindEmail.code"
                type="text"
                maxlength="12"
                autocomplete="one-time-code"
                class="input font-mono sm:flex-1"
                :placeholder="t('profile.bindEmail.codePlaceholder')"
              />
            </div>
            <div class="flex justify-end">
              <button type="submit" class="btn btn-primary" :disabled="!bindEmail.address.trim() || bindEmail.saving">
                <UiIcon :name="bindEmail.saving ? 'loader' : 'check'" :size="15" :spin="bindEmail.saving" />
                {{ bindEmail.saving ? t("common.submitting") : t("profile.bindEmail.submit") }}
              </button>
            </div>
          </form>
        </UiCard>

        <!-- Password -->
        <UiCard
          class="animate-slide-up motion-reduce:animate-none"
          :style="stagger(2)"
          icon="lock"
          :title="t('profile.password.title')"
        >
          <form class="space-y-4" autocomplete="on" @submit.prevent="changePassword">
            <!-- Hidden username lets password managers pair the new password with this account. -->
            <input type="text" name="username" autocomplete="username" :value="user?.email" class="hidden" readonly tabindex="-1" aria-hidden="true" />
            <div>
              <label for="pw-current" class="label">{{ t("profile.password.current") }}</label>
              <PasswordInput
                id="pw-current"
                v-model="pw.current"
                autocomplete="current-password"
                :invalid="Boolean(currentError)"
              />
              <p v-if="currentError" class="mt-1 flex animate-fade-in items-center gap-1 text-xs text-danger" role="alert">
                <UiIcon name="alert" :size="12" />
                {{ currentError }}
              </p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="pw-new" class="label">{{ t("profile.password.new") }}</label>
                <PasswordInput
                  id="pw-new"
                  v-model="pw.next"
                  autocomplete="new-password"
                  :placeholder="t('profile.password.newPlaceholder')"
                  :invalid="Boolean(nextError)"
                />
                <p v-if="nextError" class="mt-1 animate-fade-in text-xs text-danger">{{ nextError }}</p>
                <PasswordStrength v-else :password="pw.next" />
              </div>
              <div>
                <label for="pw-confirm" class="label">{{ t("profile.password.confirm") }}</label>
                <PasswordInput
                  id="pw-confirm"
                  v-model="pw.confirm"
                  autocomplete="new-password"
                  :invalid="Boolean(confirmError)"
                />
                <p v-if="confirmError" class="mt-1 animate-fade-in text-xs text-danger">{{ confirmError }}</p>
                <p v-else-if="confirmOk" class="mt-1 flex animate-fade-in items-center gap-1 text-xs text-success">
                  <UiIcon name="check" :size="12" />
                  {{ t("profile.password.match") }}
                </p>
              </div>
            </div>
            <div class="flex flex-col-reverse items-stretch justify-between gap-3 border-t border-line/70 pt-4 sm:flex-row sm:items-center">
              <p class="text-xs text-fg-subtle">{{ t("profile.password.footnote") }}</p>
              <button type="submit" class="btn btn-primary shrink-0" :disabled="!canChange">
                <UiIcon :name="savingPw ? 'loader' : 'lock'" :size="15" :spin="savingPw" />
                {{ savingPw ? t("common.submitting") : t("profile.password.submit") }}
              </button>
            </div>
          </form>
        </UiCard>

        <!-- Two-factor sign-in -->
        <TotpCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(3)" />

        <!-- WebAuthn Passkeys -->
        <PasskeysPanel class="animate-slide-up motion-reduce:animate-none" :style="stagger(4)" />

        <!-- Third-party sign-in identities (renders nothing when no provider is enabled) -->
        <LinkedAccountsCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(5)" />

        <!-- Sessions: this device, sign out other / all devices -->
        <SessionsCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(6)" />
      </div>
    </div>
  </div>
</template>
