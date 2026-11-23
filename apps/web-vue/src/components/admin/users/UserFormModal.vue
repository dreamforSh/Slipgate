<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AdminCreateUserRequest,
  AdminUpdateUserRequest,
  AdminUserItem,
  GroupItem,
  UserCap,
  UserRole,
  UserStatus,
} from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import GroupPicker from "./GroupPicker.vue";
import UserCapField from "./UserCapField.vue";
import { loadPortalCapDefaults, sameCap, type PortalCapDefaults } from "./limits";
import { USD_INPUT_PATTERN, normalizeUsdInput } from "./money";
import { generatePassword } from "./userDisplay";

/** Create (user = null) or edit an account, including an optional admin password reset. */
const props = defineProps<{
  user: AdminUserItem | null;
  groups: GroupItem[];
  selfId: string | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "saved", user: AdminUserItem, created: boolean): void }>();

const { t } = useI18n();
const toast = useToastStore();

interface Form {
  email: string;
  username: string;
  password: string;
  role: UserRole;
  status: UserStatus;
  notes: string;
  allowedGroupIds: string[];
  initialBalance: string;
  /** Own caps: null = portal default, 0 = unlimited. */
  rpmLimit: UserCap;
  concurrencyLimit: UserCap;
}

const form = reactive<Form>(blank());
const saving = ref(false);
const error = ref<string | null>(null);
const showPassword = ref(false);
const rpmInvalid = ref(false);
const concInvalid = ref(false);
const capDefaults = ref<PortalCapDefaults | null>(null);

const isEdit = computed(() => props.user !== null);
const isSelf = computed(() => props.user !== null && props.user.id === props.selfId);

const roleOptions = computed<{ value: UserRole; label: string }[]>(() => [
  { value: "user", label: t("adminUsers.roles.user") },
  { value: "admin", label: t("adminUsers.roles.admin") },
]);
const statusOptions = computed<{ value: UserStatus; label: string }[]>(() => [
  { value: "active", label: t("adminUsers.statuses.active") },
  { value: "suspended", label: t("adminUsers.statuses.suspended") },
]);

function blank(): Form {
  return {
    email: "",
    username: "",
    password: "",
    role: "user",
    status: "active",
    notes: "",
    allowedGroupIds: [],
    initialBalance: "",
    rpmLimit: null,
    concurrencyLimit: null,
  };
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  showPassword.value = false;
  const u = props.user;
  Object.assign(
    form,
    u
      ? {
          ...blank(),
          email: u.email,
          username: u.username,
          role: u.role,
          status: u.status,
          notes: u.notes,
          allowedGroupIds: [...u.allowedGroupIds],
          rpmLimit: u.rpmLimit ?? null,
          concurrencyLimit: u.concurrencyLimit ?? null,
        }
      : blank(),
  );
  void loadPortalCapDefaults().then((d) => (capDefaults.value = d));
});

async function generate() {
  form.password = generatePassword();
  showPassword.value = true;
  try {
    await navigator.clipboard.writeText(form.password);
    toast.success(t("adminUsers.form.generated"));
  } catch {
    // Clipboard blocked: the password is still visible in the field.
  }
}

const balanceInvalid = computed(() => form.initialBalance.trim() !== "" && normalizeUsdInput(form.initialBalance) === null);

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function buildPatch(u: AdminUserItem): AdminUpdateUserRequest {
  const patch: AdminUpdateUserRequest = {};
  const email = form.email.trim();
  const username = form.username.trim();
  const notes = form.notes.trim();
  if (email !== u.email) patch.email = email;
  if (username !== u.username) patch.username = username;
  if (notes !== u.notes) patch.notes = notes;
  if (!isSelf.value && form.role !== u.role) patch.role = form.role;
  if (!isSelf.value && form.status !== u.status) patch.status = form.status;
  if (!sameIds(form.allowedGroupIds, u.allowedGroupIds)) patch.allowedGroupIds = [...form.allowedGroupIds];
  if (form.password) patch.password = form.password;
  if (!sameCap(form.rpmLimit, u.rpmLimit)) patch.rpmLimit = form.rpmLimit;
  if (!sameCap(form.concurrencyLimit, u.concurrencyLimit)) patch.concurrencyLimit = form.concurrencyLimit;
  return patch;
}

async function submit() {
  if (saving.value || balanceInvalid.value || rpmInvalid.value || concInvalid.value) return;
  error.value = null;
  saving.value = true;
  try {
    const u = props.user;
    if (u) {
      const patch = buildPatch(u);
      if (Object.keys(patch).length === 0) {
        open.value = false;
        return;
      }
      const res = await apiJson<{ user: AdminUserItem }>(`/api/v1/admin/users/${encodeURIComponent(u.id)}`, {
        method: "PATCH",
        body: patch,
        fallbackError: t("adminUsers.errors.save"),
      });
      emit("saved", res.user, false);
    } else {
      const balance = form.initialBalance.trim() ? normalizeUsdInput(form.initialBalance) : null;
      const body: AdminCreateUserRequest = {
        email: form.email.trim(),
        password: form.password,
        username: form.username.trim(),
        role: form.role,
        notes: form.notes.trim(),
        allowedGroupIds: [...form.allowedGroupIds],
        ...(balance !== null ? { initialBalanceUsd: balance } : {}),
        ...(form.rpmLimit !== null ? { rpmLimit: form.rpmLimit } : {}),
        ...(form.concurrencyLimit !== null ? { concurrencyLimit: form.concurrencyLimit } : {}),
      };
      const res = await apiJson<{ user: AdminUserItem }>("/api/v1/admin/users", {
        method: "POST",
        body,
        fallbackError: t("adminUsers.errors.create"),
      });
      emit("saved", res.user, true);
    }
    open.value = false;
  } catch (err) {
    error.value = errorText(err, isEdit.value ? t("adminUsers.errors.save") : t("adminUsers.errors.create"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal
    v-model:open="open"
    width="lg"
    :persistent="saving"
    :title="isEdit ? t('adminUsers.form.editTitle') : t('adminUsers.form.createTitle')"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="isEdit ? 'pencil' : 'user-plus'" :size="15" />
      </span>
    </template>

    <form id="admin-user-form" class="grid gap-4 sm:grid-cols-2" @submit.prevent="submit">
      <UiAlert v-if="error" tone="danger" class="animate-fade-in sm:col-span-2">{{ error }}</UiAlert>

      <FormField :label="t('adminUsers.form.email')" required>
        <input
          v-model="form.email"
          type="email"
          required
          maxlength="254"
          autocomplete="off"
          :placeholder="t('adminUsers.form.emailPlaceholder')"
          class="input"
        />
      </FormField>
      <FormField :label="t('adminUsers.form.username')">
        <input
          v-model="form.username"
          type="text"
          maxlength="64"
          autocomplete="off"
          :placeholder="t('adminUsers.form.usernamePlaceholder')"
          class="input"
        />
      </FormField>

      <div class="sm:col-span-2">
        <label class="label" for="admin-user-password">
          {{ isEdit ? t("adminUsers.form.resetPassword") : t("adminUsers.form.password") }}
          <span v-if="!isEdit" class="text-danger">*</span>
        </label>
        <div class="flex gap-2">
          <div class="relative min-w-0 flex-1">
            <input
              id="admin-user-password"
              v-model="form.password"
              :type="showPassword ? 'text' : 'password'"
              :required="!isEdit"
              minlength="8"
              maxlength="128"
              autocomplete="new-password"
              spellcheck="false"
              :placeholder="isEdit ? t('adminUsers.form.resetPasswordPlaceholder') : t('adminUsers.form.passwordPlaceholder')"
              class="input pr-9 font-mono"
            />
            <button
              type="button"
              class="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
              :aria-label="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
              :title="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
              @click="showPassword = !showPassword"
            >
              <UiIcon :name="showPassword ? 'eye-off' : 'eye'" :size="14" />
            </button>
          </div>
          <button type="button" class="btn btn-secondary shrink-0" @click="generate">
            <UiIcon name="sparkles" :size="14" />
            {{ t("adminUsers.form.generate") }}
          </button>
        </div>
      </div>

      <div>
        <p class="label">{{ t("adminUsers.form.role") }}</p>
        <SegmentedControl
          :model-value="form.role"
          :options="roleOptions"
          size="md"
          block
          :class="isSelf ? 'pointer-events-none opacity-60' : ''"
          @update:model-value="(v) => !isSelf && (form.role = v)"
        />
      </div>
      <div v-if="isEdit">
        <p class="label">{{ t("adminUsers.form.status") }}</p>
        <SegmentedControl
          :model-value="form.status"
          :options="statusOptions"
          size="md"
          block
          :class="isSelf ? 'pointer-events-none opacity-60' : ''"
          @update:model-value="(v) => !isSelf && (form.status = v)"
        />
      </div>
      <FormField v-else :label="t('adminUsers.form.initialBalance')">
        <input
          v-model="form.initialBalance"
          type="text"
          inputmode="decimal"
          :pattern="USD_INPUT_PATTERN"
          :placeholder="t('adminUsers.form.initialBalancePlaceholder')"
          class="input font-mono"
          :class="balanceInvalid ? '!border-danger focus:!ring-danger/20' : ''"
        />
        <span class="hint block" :class="balanceInvalid ? '!text-danger' : ''">
          {{ balanceInvalid ? t("adminUsers.form.invalidAmount") : t("adminUsers.form.initialBalanceHint") }}
        </span>
      </FormField>
      <p v-if="isSelf" class="-mt-2 flex items-center gap-1.5 text-xs text-fg-subtle sm:col-span-2">
        <UiIcon name="lock" :size="12" />
        {{ t("adminUsers.form.selfLocked") }}
      </p>

      <GroupPicker v-model="form.allowedGroupIds" :groups="groups" class="sm:col-span-2" />

      <fieldset class="min-w-0 rounded-lg border border-line/80 bg-surface-2/30 p-3.5 sm:col-span-2">
        <legend class="sr-only">{{ t("userLimits.form.title") }}</legend>
        <div class="mb-3 flex items-start gap-2.5">
          <span class="icon-chip icon-chip-accent h-7 w-7"><UiIcon name="gauge" :size="14" /></span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-fg">{{ t("userLimits.form.title") }}</p>
            <p class="text-xs text-fg-subtle">{{ t("userLimits.form.hint") }}</p>
          </div>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <UserCapField
            id="uf-rpm"
            v-model="form.rpmLimit"
            v-model:invalid="rpmInvalid"
            kind="rpm"
            :label="t('userLimits.fields.rpm')"
            :portal-default="capDefaults?.rpm ?? null"
            :disabled="saving"
          />
          <UserCapField
            id="uf-conc"
            v-model="form.concurrencyLimit"
            v-model:invalid="concInvalid"
            kind="concurrency"
            :label="t('userLimits.fields.concurrency')"
            :portal-default="capDefaults?.concurrency ?? null"
            :disabled="saving"
          />
        </div>
      </fieldset>

      <FormField :label="t('adminUsers.form.notes')" class="sm:col-span-2">
        <textarea
          v-model="form.notes"
          rows="2"
          maxlength="1000"
          :placeholder="t('adminUsers.form.notesPlaceholder')"
          class="textarea"
        />
      </FormField>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="open = false">
        {{ t("common.cancel") }}
      </button>
      <button type="submit" form="admin-user-form" class="btn btn-primary" :disabled="saving || balanceInvalid || rpmInvalid || concInvalid">
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ isEdit ? t("adminUsers.form.submitSave") : t("adminUsers.form.submitCreate") }}
      </button>
    </template>
  </UiModal>
</template>
