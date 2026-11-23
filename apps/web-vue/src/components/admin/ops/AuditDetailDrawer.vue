<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AuditLogItem } from "@slipgate/contracts";
import CopyButton from "../../ui/CopyButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatDateTime, formatDurationMs, formatRelative } from "../../../lib/format";
import { auditActionKey } from "./auditActions";
import { httpStatusTone, methodTone } from "./opsUtil";

/** Everything recorded for one admin write, including the (redacted) request body. */
const props = defineProps<{ open: boolean; item: AuditLogItem | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();

const actionName = computed(() => {
  const it = props.item;
  if (!it) return "";
  const key = auditActionKey(it.method, it.route);
  return key ? t(`audit.actions.${key}`) : it.route || it.path;
});

const prettyBody = computed(() => {
  const raw = props.item?.requestBody?.trim() ?? "";
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Token colouring for JSON; every fragment is escaped before it is wrapped. */
const highlighted = computed(() => {
  const json = prettyBody.value;
  const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = "";
  let last = 0;
  for (const m of json.matchAll(re)) {
    const index = m.index ?? 0;
    const token = m[0];
    out += escapeHtml(json.slice(last, index));
    let cls = "text-info";
    if (token.startsWith('"')) cls = m[2] ? "text-accent" : "text-success";
    else if (token === "true" || token === "false" || token === "null") cls = "text-violet";
    out += `<span class="${cls}">${escapeHtml(token)}</span>`;
    last = index + token.length;
  }
  return out + escapeHtml(json.slice(last));
});

const roleLabel = computed(() => {
  const role = props.item?.actorRole ?? "";
  return role === "admin" || role === "user" ? t(`shell.roles.${role}`) : role || "-";
});
</script>

<template>
  <UiDrawer :open="open" width="lg" :title="t('audit.detail.title')" @update:open="emit('update:open', $event)">
    <div v-if="item" class="space-y-5">
      <!-- Headline -->
      <div class="rounded-xl border border-line bg-surface-2/40 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiBadge :tone="methodTone(item.method)" mono>{{ item.method }}</UiBadge>
          <UiBadge :tone="httpStatusTone(item.statusCode)" dot mono>{{ item.statusCode }}</UiBadge>
          <span class="ml-auto text-xs text-fg-subtle" :title="formatRelative(item.createdAtIso)">
            {{ formatDateTime(item.createdAtIso) }}
          </span>
        </div>
        <p class="mt-2 text-base font-semibold text-fg">{{ actionName }}</p>
        <p class="mt-1 break-all font-mono text-2xs text-fg-subtle">{{ item.path }}</p>
      </div>

      <!-- Overview -->
      <section>
        <p class="eyebrow mb-2">{{ t("audit.detail.overview") }}</p>
        <dl class="kv grid-cols-2 rounded-xl border border-line px-4 py-3.5">
          <div class="col-span-2 sm:col-span-1">
            <dt>{{ t("audit.detail.actor") }}</dt>
            <dd class="!font-sans" :title="item.actorEmail">{{ item.actorEmail || item.actorId }}</dd>
          </div>
          <div>
            <dt>{{ t("audit.detail.role") }}</dt>
            <dd class="!font-sans">{{ roleLabel }}</dd>
          </div>
          <div>
            <dt>{{ t("audit.detail.duration") }}</dt>
            <dd>{{ formatDurationMs(item.durationMs) }}</dd>
          </div>
          <div class="col-span-2 sm:col-span-1">
            <dt>{{ t("audit.detail.target") }}</dt>
            <dd class="flex items-center gap-1">
              <span class="truncate" :title="item.targetId">{{ item.targetId || "-" }}</span>
              <CopyButton v-if="item.targetId" :text="item.targetId" />
            </dd>
          </div>
          <div class="col-span-2">
            <dt>{{ t("audit.detail.id") }}</dt>
            <dd :title="item.id">{{ item.id }}</dd>
          </div>
        </dl>
      </section>

      <!-- Request -->
      <section>
        <p class="eyebrow mb-2">{{ t("audit.detail.request") }}</p>
        <dl class="kv grid-cols-1 rounded-xl border border-line px-4 py-3.5">
          <div>
            <dt>{{ t("audit.detail.route") }}</dt>
            <dd class="!whitespace-normal break-all">{{ item.route || "-" }}</dd>
          </div>
          <div>
            <dt>{{ t("audit.detail.path") }}</dt>
            <dd class="!whitespace-normal break-all">{{ item.path }}</dd>
          </div>
        </dl>
      </section>

      <!-- Client -->
      <section>
        <p class="eyebrow mb-2">{{ t("audit.detail.client") }}</p>
        <dl class="kv grid-cols-1 rounded-xl border border-line px-4 py-3.5">
          <div>
            <dt>{{ t("audit.detail.ip") }}</dt>
            <dd>{{ item.ip || "-" }}</dd>
          </div>
          <div>
            <dt>{{ t("audit.detail.userAgent") }}</dt>
            <dd class="!whitespace-normal break-all !text-fg-muted">{{ item.userAgent || "-" }}</dd>
          </div>
        </dl>
      </section>

      <!-- Body -->
      <section>
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="eyebrow">{{ t("audit.detail.body") }}</p>
          <CopyButton v-if="prettyBody" :text="prettyBody" :label="t('audit.detail.copyBody')" />
        </div>
        <template v-if="prettyBody">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre
            class="max-h-[50vh] overflow-auto rounded-xl border border-line bg-surface-2/50 p-3.5 font-mono text-2xs leading-relaxed text-fg"
            v-html="highlighted"
          />
          <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-fg-subtle">
            <UiIcon name="shield" :size="12" />
            {{ t("audit.detail.bodyHint") }}
          </p>
        </template>
        <p v-else class="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-fg-subtle">
          {{ t("audit.detail.noBody") }}
        </p>
      </section>
    </div>
  </UiDrawer>
</template>
