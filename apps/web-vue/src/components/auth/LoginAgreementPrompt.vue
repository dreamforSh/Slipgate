<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { PublicLoginAgreementDocument } from "@slipgate/contracts";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";

/**
 * Consent to the site's agreement documents before signing in or up.
 * - checkbox mode: "I have read and agree to …" above the submit button;
 * - modal mode: a dialog when the page opens; declining leaves a notice to review it again.
 * Documents open at /legal/:id in a new tab.
 */
const props = defineProps<{
  mode: "modal" | "checkbox";
  documents: PublicLoginAgreementDocument[];
  updatedAt: string;
  accepted: boolean;
  /** Whether a submit was attempted without consent (highlights the checkbox). */
  attention?: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "accept"): void; (e: "reject"): void }>();

const { t } = useI18n();

function legalHref(doc: PublicLoginAgreementDocument) {
  return { name: "legal-document", params: { documentId: doc.id } };
}

/** A fitting icon per document (privacy policies get the shield). */
function docIcon(doc: PublicLoginAgreementDocument): IconName {
  const text = `${doc.id} ${doc.title}`.toLowerCase();
  if (/privacy|policy|cookie|隐私|政策/.test(text)) return "shield";
  if (/refund|billing|payment|退款|付费|支付/.test(text)) return "credit-card";
  return "file";
}

function onCheckbox(ev: Event) {
  if ((ev.target as HTMLInputElement).checked) emit("accept");
  else emit("reject");
}

const description = computed(() =>
  props.updatedAt ? t("authGuards.agreement.dialogBody", { date: props.updatedAt }) : t("authGuards.agreement.dialogBodyNoDate"),
);
</script>

<template>
  <!-- Checkbox mode -->
  <div
    v-if="mode === 'checkbox'"
    class="flex items-start gap-2.5 rounded-lg px-0.5 transition-colors duration-200"
    :class="attention && !accepted ? 'agreement-attention' : ''"
  >
    <input
      id="login-agreement-consent"
      type="checkbox"
      class="checkbox mt-0.5 shrink-0"
      :checked="accepted"
      :aria-invalid="attention && !accepted"
      aria-describedby="login-agreement-docs"
      @change="onCheckbox"
    />
    <p id="login-agreement-docs" class="min-w-0 text-xs leading-5 text-fg-muted">
      <label for="login-agreement-consent" class="cursor-pointer">{{ t("authGuards.agreement.checkboxPrefix") }}</label>
      <template v-for="(doc, i) in documents" :key="doc.id">
        <RouterLink
          :to="legalHref(doc)"
          target="_blank"
          rel="noopener"
          class="font-medium text-accent underline-offset-2 hover:underline"
        >
          {{ t("authGuards.agreement.quoted", { title: doc.title }) }}
        </RouterLink>
        <span v-if="i < documents.length - 1">{{ t("authGuards.agreement.separator") }}</span>
      </template>
    </p>
  </div>

  <!-- Modal mode: declined (or closed) -->
  <div
    v-else-if="!accepted"
    class="flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/[0.06] px-3.5 py-3 animate-fade-in motion-reduce:animate-none"
    role="status"
  >
    <UiIcon name="shield" :size="16" class="mt-0.5 shrink-0 text-accent" />
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-fg">{{ t("authGuards.agreement.noticeTitle") }}</p>
      <p class="mt-0.5 text-xs leading-relaxed text-fg-muted">{{ t("authGuards.agreement.noticeBody") }}</p>
    </div>
    <button type="button" class="btn btn-primary btn-sm shrink-0" @click="open = true">
      {{ t("authGuards.agreement.review") }}
    </button>
  </div>

  <!-- Modal mode: accepted -->
  <p v-else class="flex items-start gap-1.5 text-2xs leading-5 text-fg-subtle">
    <UiIcon name="check-circle" :size="12" class="mt-1 shrink-0 text-success" />
    <span class="min-w-0">
      {{ t("authGuards.agreement.acceptedPrefix") }}
      <template v-for="(doc, i) in documents" :key="doc.id">
        <RouterLink :to="legalHref(doc)" target="_blank" rel="noopener" class="text-fg-muted underline-offset-2 hover:text-accent hover:underline">
          {{ t("authGuards.agreement.quoted", { title: doc.title }) }}
        </RouterLink>
        <span v-if="i < documents.length - 1">{{ t("authGuards.agreement.separator") }}</span>
      </template>
    </span>
  </p>

  <UiModal
    v-if="mode === 'modal'"
    v-model:open="open"
    :title="t('authGuards.agreement.dialogTitle')"
    width="md"
    persistent
    @close="emit('reject')"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="shield" :size="16" /></span>
    </template>
    <p class="text-sm leading-relaxed text-fg-muted">{{ description }}</p>
    <p class="eyebrow mt-5">{{ t("authGuards.agreement.documents") }}</p>
    <ul class="mt-2 grid gap-2 sm:grid-cols-2">
      <li v-for="doc in documents" :key="doc.id">
        <RouterLink
          :to="legalHref(doc)"
          target="_blank"
          rel="noopener"
          class="group flex min-h-[3.5rem] items-center gap-3 rounded-xl border border-line bg-surface-2/40 px-3.5 py-2.5 transition-[border-color,background-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-accent/40 hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:hover:translate-y-0"
          :aria-label="t('authGuards.agreement.openDocument', { title: doc.title })"
        >
          <span class="icon-chip h-9 w-9 bg-surface text-fg-muted ring-1 ring-inset ring-line transition-colors group-hover:bg-accent/10 group-hover:text-accent">
            <UiIcon :name="docIcon(doc)" :size="16" />
          </span>
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-fg">{{ doc.title }}</span>
          <UiIcon name="external-link" :size="14" class="shrink-0 text-fg-subtle transition-colors group-hover:text-accent" />
        </RouterLink>
      </li>
    </ul>
    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('reject')">
        {{ t("authGuards.agreement.decline") }}
      </button>
      <button type="button" class="btn btn-primary" @click="emit('accept')">
        <UiIcon name="check" :size="15" />
        {{ t("authGuards.agreement.accept") }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.agreement-attention {
  animation: agreement-nudge 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 0 0 2px rgb(var(--warning) / 0.35);
}
@keyframes agreement-nudge {
  0%,
  100% {
    transform: translateX(0);
  }
  30% {
    transform: translateX(-3px);
  }
  60% {
    transform: translateX(3px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .agreement-attention {
    animation: none;
  }
}
</style>
