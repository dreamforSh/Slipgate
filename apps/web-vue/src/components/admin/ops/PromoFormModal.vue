<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CreatePromoCodeRequest, PromoCodeItem, UpdatePromoCodeRequest } from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import { isoToLocalInput, localInputToIso, nanoToUsdInput, normalizeUsdInput } from "./opsUtil";

/** Create or edit a registration promo code. The code text itself is fixed after creation. */
const props = defineProps<{ open: boolean; item: PromoCodeItem | null }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "saved", item: PromoCodeItem, created: boolean): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

interface PromoForm {
  code: string;
  bonusUsd: string;
  maxUses: number;
  expiresLocal: string;
  notes: string;
  enabled: boolean;
}

const form = reactive<PromoForm>({ code: "", bonusUsd: "", maxUses: 0, expiresLocal: "", notes: "", enabled: true });
const saving = ref(false);
const attempted = ref(false);
const editing = computed(() => props.item !== null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    attempted.value = false;
    const it = props.item;
    Object.assign(form, {
      code: it?.code ?? "",
      bonusUsd: it ? nanoToUsdInput(it.bonusNanoUsd) : "",
      maxUses: it?.maxUses ?? 0,
      expiresLocal: isoToLocalInput(it?.expiresAtIso),
      notes: it?.notes ?? "",
      enabled: it?.enabled ?? true,
    } satisfies PromoForm);
  },
  { immediate: true },
);

function onCode(ev: Event) {
  const el = ev.target as HTMLInputElement;
  form.code = el.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
  el.value = form.code;
}

const errors = computed(() => {
  const e: Partial<Record<"code" | "bonus" | "maxUses" | "expiry", string>> = {};
  if (!editing.value && form.code && !/^[A-Z0-9_-]{3,32}$/.test(form.code)) e.code = t("promo.form.errors.code");
  if (!normalizeUsdInput(form.bonusUsd)) e.bonus = t("promo.form.errors.bonus");
  if (!Number.isInteger(form.maxUses) || form.maxUses < 0 || form.maxUses > 1_000_000) {
    e.maxUses = t("promo.form.errors.maxUses");
  }
  const iso = localInputToIso(form.expiresLocal);
  const unchanged = editing.value && form.expiresLocal === isoToLocalInput(props.item?.expiresAtIso);
  if (form.expiresLocal && (!iso || (!unchanged && Date.parse(iso) <= Date.now()))) e.expiry = t("promo.form.errors.expiry");
  return e;
});
const shown = computed(() => (attempted.value ? errors.value : {}));

function buildPatch(original: PromoCodeItem): UpdatePromoCodeRequest {
  const patch: UpdatePromoCodeRequest = {};
  const bonus = normalizeUsdInput(form.bonusUsd) ?? "";
  if (bonus !== nanoToUsdInput(original.bonusNanoUsd)) patch.bonusUsd = bonus;
  if (form.maxUses !== original.maxUses) patch.maxUses = form.maxUses;
  if (form.enabled !== original.enabled) patch.enabled = form.enabled;
  const iso = localInputToIso(form.expiresLocal);
  // datetime-local drops seconds: compare at minute precision so an untouched field is not "changed".
  if (isoToLocalInput(iso) !== isoToLocalInput(original.expiresAtIso)) patch.expiresAtIso = iso;
  const notes = form.notes.trim();
  if (notes !== original.notes) patch.notes = notes;
  return patch;
}

async function submit() {
  attempted.value = true;
  if (Object.keys(errors.value).length > 0) return;
  saving.value = true;
  try {
    const original = props.item;
    if (original) {
      const patch = buildPatch(original);
      if (Object.keys(patch).length === 0) {
        emit("update:open", false);
        return;
      }
      const { item } = await apiJson<{ item: PromoCodeItem }>(`/api/v1/admin/promo-codes/${encodeURIComponent(original.id)}`, {
        method: "PATCH",
        body: patch,
        fallbackError: t("promo.errors.save"),
      });
      emit("saved", item, false);
    } else {
      const body: CreatePromoCodeRequest = {
        ...(form.code ? { code: form.code } : {}),
        bonusUsd: normalizeUsdInput(form.bonusUsd) ?? "",
        maxUses: form.maxUses,
        enabled: form.enabled,
        expiresAtIso: localInputToIso(form.expiresLocal),
        notes: form.notes.trim(),
      };
      const { item } = await apiJson<{ item: PromoCodeItem }>("/api/v1/admin/promo-codes", {
        method: "POST",
        body,
        fallbackError: t("promo.errors.save"),
      });
      emit("saved", item, true);
    }
    emit("update:open", false);
  } catch (err) {
    toast.error(errorText(err, t("promo.errors.save")));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal
    :open="open"
    width="md"
    :title="editing ? t('promo.form.editTitle') : t('promo.form.createTitle')"
    :persistent="saving"
    @update:open="emit('update:open', $event)"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="editing ? 'pencil' : 'percent'" :size="15" />
      </span>
    </template>

    <form id="promo-form" class="grid gap-4 sm:grid-cols-2" novalidate @submit.prevent="submit">
      <FormField :label="t('promo.form.code')" class="sm:col-span-2">
        <span class="relative block">
          <input
            :value="form.code"
            type="text"
            maxlength="32"
            autocomplete="off"
            spellcheck="false"
            class="input font-mono uppercase tracking-wider"
            :class="shown.code ? '!border-danger' : ''"
            :placeholder="t('promo.form.codePlaceholder')"
            :disabled="editing"
            @input="onCode"
          />
          <UiIcon
            v-if="editing"
            name="lock"
            :size="13"
            class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
        </span>
        <p class="mt-1 text-xs" :class="shown.code ? 'text-danger' : 'text-fg-subtle'">
          {{ shown.code ?? (editing ? t("promo.form.codeLocked") : t("promo.form.codeHint")) }}
        </p>
      </FormField>

      <FormField :label="t('promo.form.bonus')" required>
        <span class="relative block">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">$</span>
          <input
            v-model="form.bonusUsd"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            class="input pl-7 font-mono"
            :class="shown.bonus ? '!border-danger' : ''"
            :placeholder="t('promo.form.bonusPlaceholder')"
          />
        </span>
        <p v-if="shown.bonus" class="mt-1 text-xs text-danger">{{ shown.bonus }}</p>
      </FormField>

      <FormField :label="t('promo.form.maxUses')">
        <input
          v-model.number="form.maxUses"
          type="number"
          min="0"
          max="1000000"
          step="1"
          class="input font-mono"
          :class="shown.maxUses ? '!border-danger' : ''"
        />
        <p class="mt-1 text-xs" :class="shown.maxUses ? 'text-danger' : 'text-fg-subtle'">
          {{ shown.maxUses ?? t("promo.form.maxUsesHint") }}
        </p>
      </FormField>

      <FormField :label="t('promo.form.expiresAt')" class="sm:col-span-2">
        <span class="flex gap-2">
          <input
            v-model="form.expiresLocal"
            type="datetime-local"
            class="input"
            :class="shown.expiry ? '!border-danger' : ''"
          />
          <button
            v-if="form.expiresLocal"
            type="button"
            class="btn btn-ghost shrink-0"
            @click.prevent="form.expiresLocal = ''"
          >
            <UiIcon name="x" :size="14" />
            {{ t("promo.form.clearExpiry") }}
          </button>
        </span>
        <p class="mt-1 text-xs" :class="shown.expiry ? 'text-danger' : 'text-fg-subtle'">
          {{ shown.expiry ?? t("promo.form.expiresHint") }}
        </p>
      </FormField>

      <FormField :label="t('promo.form.notes')" class="sm:col-span-2">
        <input v-model="form.notes" type="text" maxlength="200" class="input" :placeholder="t('promo.form.notesPlaceholder')" />
      </FormField>

      <div
        class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3 sm:col-span-2"
      >
        <p class="flex items-center gap-2 text-sm font-medium text-fg">
          <UiIcon name="check-circle" :size="14" class="text-success" />
          {{ t("promo.form.enabled") }}
        </p>
        <UiSwitch v-model="form.enabled" :label="t('promo.form.enabled')" hide-label />
      </div>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="emit('update:open', false)">
        {{ t("common.cancel") }}
      </button>
      <button type="submit" form="promo-form" class="btn btn-primary" :disabled="saving">
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ editing ? t("promo.form.submitSave") : t("promo.form.submitCreate") }}
      </button>
    </template>
  </UiModal>
</template>
