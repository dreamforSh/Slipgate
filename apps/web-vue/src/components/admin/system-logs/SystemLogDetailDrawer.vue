<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SystemLogItem } from "@slipgate/contracts";
import CopyButton from "../../ui/CopyButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatDurationMs, formatRelative } from "../../../lib/format";
import { httpStatusTone, methodTone } from "../ops/opsUtil";
import {
  LEVEL_TONE,
  SOURCE_TONE,
  contextCaller,
  contextError,
  contextStack,
  formatLogClock,
  formatLogDate,
  highlightJson,
  httpSummary,
  type TextFilterKey,
} from "./systemLogUtil";

/** One stored entry: message, correlation ids (each can become a filter) and the redacted context. */
const props = defineProps<{
  open: boolean;
  item: SystemLogItem | null;
  hasNewer: boolean;
  hasOlder: boolean;
}>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  /** -1 = newer entry (up the list), 1 = older entry. */
  (e: "navigate", delta: -1 | 1): void;
  (e: "filter", key: TextFilterKey, value: string): void;
}>();

const { t } = useI18n();

const http = computed(() => (props.item ? httpSummary(props.item) : null));
const errorLine = computed(() => (props.item ? contextError(props.item) : ""));
const stack = computed(() => (props.item ? contextStack(props.item) : ""));
const caller = computed(() => (props.item ? contextCaller(props.item) : ""));

const contextJson = computed(() => {
  const c = props.item?.context;
  if (!c || Object.keys(c).length === 0) return "";
  try {
    return JSON.stringify(c, null, 2);
  } catch {
    return "";
  }
});
const highlighted = computed(() => highlightJson(contextJson.value));
const entryJson = computed(() => (props.item ? JSON.stringify(props.item, null, 2) : ""));

interface Field {
  key: TextFilterKey | "id";
  label: string;
  value: string;
  filterable: boolean;
}

const fields = computed<Field[]>(() => {
  const it = props.item;
  if (!it) return [];
  const rows: Field[] = [
    { key: "requestId", label: t("systemLogs.fields.requestId"), value: it.requestId, filterable: true },
    { key: "clientRequestId", label: t("systemLogs.fields.clientRequestId"), value: it.clientRequestId, filterable: true },
    { key: "userId", label: t("systemLogs.fields.userId"), value: it.userId ?? "", filterable: true },
    { key: "apiKeyId", label: t("systemLogs.fields.apiKeyId"), value: it.apiKeyId ?? "", filterable: true },
    { key: "accountId", label: t("systemLogs.fields.accountId"), value: it.accountId ?? "", filterable: true },
    { key: "platform", label: t("systemLogs.fields.platform"), value: it.platform, filterable: true },
    { key: "model", label: t("systemLogs.fields.model"), value: it.model, filterable: true },
    { key: "host", label: t("systemLogs.fields.host"), value: it.host, filterable: true },
    { key: "id", label: t("systemLogs.fields.id"), value: it.id, filterable: false },
  ];
  return rows.filter((r) => r.value !== "");
});

function filterBy(key: TextFilterKey, value: string) {
  emit("filter", key, value);
  emit("update:open", false);
}

/* j / k step through the list while the drawer is open (not while typing). */
function onKeydown(ev: KeyboardEvent) {
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const el = ev.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (ev.key === "j" && props.hasOlder) emit("navigate", 1);
  else if (ev.key === "k" && props.hasNewer) emit("navigate", -1);
}
watch(
  () => props.open,
  (open) => {
    if (open) document.addEventListener("keydown", onKeydown);
    else document.removeEventListener("keydown", onKeydown);
  },
  { immediate: true },
);
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <UiDrawer :open="open" width="lg" :title="t('systemLogs.detail.title')" @update:open="emit('update:open', $event)">
    <Transition
      mode="out-in"
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
      enter-from-class="translate-y-1 opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="item" :key="item.id" class="space-y-5">
        <!-- Headline -->
        <div class="rounded-xl border border-line bg-surface-2/40 p-4">
          <div class="flex flex-wrap items-center gap-2">
            <UiBadge :tone="LEVEL_TONE[item.level]" dot mono>{{ item.level }}</UiBadge>
            <UiBadge :tone="SOURCE_TONE[item.source]" mono>{{ item.source }}</UiBadge>
            <button
              v-if="item.component"
              type="button"
              class="code-chip max-w-full cursor-pointer transition-colors hover:text-accent hover:ring-accent/30"
              :title="t('systemLogs.detail.filterBy', { field: t('systemLogs.fields.component') })"
              @click="filterBy('component', item.component)"
            >
              <span class="truncate">{{ item.component }}</span>
            </button>
            <span class="ml-auto whitespace-nowrap text-xs tabular-nums text-fg-subtle" :title="formatRelative(item.createdAtIso)">
              {{ formatLogDate(item.createdAtIso) }} {{ formatLogClock(item.createdAtIso) }}
            </span>
          </div>
          <p class="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{{ item.message || "-" }}</p>
          <p v-if="errorLine && errorLine !== item.message" class="mt-2 flex items-start gap-1.5 break-words text-xs text-danger">
            <UiIcon name="x-circle" :size="13" class="mt-0.5 shrink-0" />
            <span class="min-w-0">{{ errorLine }}</span>
          </p>
        </div>

        <!-- HTTP request -->
        <section v-if="http">
          <p class="eyebrow mb-2">{{ t("systemLogs.detail.request") }}</p>
          <div class="rounded-xl border border-line px-4 py-3.5">
            <div class="flex flex-wrap items-center gap-2">
              <UiBadge v-if="http.method" :tone="methodTone(http.method)" mono>{{ http.method }}</UiBadge>
              <UiBadge v-if="http.status !== null" :tone="httpStatusTone(http.status)" dot mono>{{ http.status }}</UiBadge>
              <span v-if="http.latencyMs !== null" class="ml-auto font-mono text-xs tabular-nums text-fg-muted">
                {{ formatDurationMs(http.latencyMs) }}
              </span>
            </div>
            <p v-if="http.path" class="mt-2 break-all font-mono text-xs text-fg">{{ http.path }}</p>
          </div>
        </section>

        <!-- Correlation -->
        <section v-if="fields.length">
          <p class="eyebrow mb-2">{{ t("systemLogs.detail.correlation") }}</p>
          <dl class="divide-y divide-line/60 rounded-xl border border-line">
            <div v-for="f in fields" :key="f.key" class="flex items-center gap-3 px-4 py-2">
              <dt class="w-28 shrink-0 text-xs text-fg-subtle">{{ f.label }}</dt>
              <dd class="flex min-w-0 flex-1 items-center gap-0.5">
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg" :title="f.value">{{ f.value }}</span>
                <CopyButton :text="f.value" />
                <button
                  v-if="f.filterable"
                  type="button"
                  class="btn btn-ghost btn-icon btn-xs"
                  :title="t('systemLogs.detail.filterBy', { field: f.label })"
                  :aria-label="t('systemLogs.detail.filterBy', { field: f.label })"
                  @click="filterBy(f.key as TextFilterKey, f.value)"
                >
                  <UiIcon name="filter" :size="13" />
                </button>
              </dd>
            </div>
          </dl>
        </section>

        <!-- Caller & stack -->
        <section v-if="caller || stack">
          <div class="mb-2 flex items-center justify-between gap-2">
            <p class="eyebrow">{{ t("systemLogs.detail.stack") }}</p>
            <CopyButton v-if="stack" :text="stack" :label="t('systemLogs.detail.copyStack')" />
          </div>
          <p v-if="caller" class="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
            <UiIcon name="branch" :size="13" class="shrink-0 text-fg-subtle" />
            <span class="text-fg-subtle">{{ t("systemLogs.detail.caller") }}</span>
            <span class="min-w-0 truncate font-mono text-fg" :title="caller">{{ caller }}</span>
          </p>
          <pre
            v-if="stack"
            class="max-h-64 overflow-auto rounded-xl border border-danger/20 bg-danger/[0.04] p-3.5 font-mono text-2xs leading-relaxed text-fg"
          >{{ stack }}</pre>
        </section>

        <!-- Context -->
        <section>
          <div class="mb-2 flex items-center justify-between gap-2">
            <p class="eyebrow">{{ t("systemLogs.detail.context") }}</p>
            <CopyButton v-if="contextJson" :text="contextJson" :label="t('systemLogs.detail.copyContext')" />
          </div>
          <template v-if="contextJson">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <pre
              class="max-h-[50vh] overflow-auto rounded-xl border border-line bg-surface-2/50 p-3.5 font-mono text-2xs leading-relaxed text-fg"
              v-html="highlighted"
            />
            <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-fg-subtle">
              <UiIcon name="shield" :size="12" />
              {{ t("systemLogs.detail.redacted") }}
            </p>
          </template>
          <p v-else class="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-fg-subtle">
            {{ t("systemLogs.detail.noContext") }}
          </p>
        </section>
      </div>
    </Transition>

    <template #footer>
      <CopyButton v-if="item" class="mr-auto" size="sm" :text="entryJson" :label="t('systemLogs.detail.copyEntry')" />
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="!hasNewer"
        aria-keyshortcuts="k"
        :title="t('systemLogs.detail.newerHint')"
        @click="emit('navigate', -1)"
      >
        <UiIcon name="arrow-up" :size="13" />
        {{ t("systemLogs.detail.newer") }}
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="!hasOlder"
        aria-keyshortcuts="j"
        :title="t('systemLogs.detail.olderHint')"
        @click="emit('navigate', 1)"
      >
        <UiIcon name="arrow-down" :size="13" />
        {{ t("systemLogs.detail.older") }}
      </button>
    </template>
  </UiDrawer>
</template>
