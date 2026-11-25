<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ACCOUNT_TEST_HISTORY_LIMIT, type AccountTestRun, type AccountTestRunsResponse } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatDurationMs, formatRelative } from "../../../lib/format";

/**
 * An account's test history (sub2api "测试结果"): console, scheduled and automatic tests of every
 * kind, newest first. The parent calls `reload()` after a test it ran finishes.
 */
const props = defineProps<{ accountId: string | null }>();
const emit = defineEmits<{ (e: "count", n: number): void }>();

const { t, te } = useI18n();
const runs = ref<AccountTestRun[]>([]);
const loading = ref(false);
const error = ref("");
const loaded = ref(false);
const now = ref(Date.now());
let seq = 0;

async function reload() {
  const id = props.accountId;
  if (!id) return;
  const mine = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const res = await apiJson<AccountTestRunsResponse>(`/api/v1/admin/accounts/${encodeURIComponent(id)}/test-runs`);
    if (mine !== seq) return;
    runs.value = res.items;
    loaded.value = true;
    now.value = Date.now();
    emit("count", res.items.length);
  } catch (err) {
    if (mine === seq) error.value = errorText(err, "HTTP error");
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(
  () => props.accountId,
  () => {
    runs.value = [];
    loaded.value = false;
    void reload();
  },
  { immediate: true },
);

defineExpose({ reload });

const passed = computed(() => runs.value.filter((r) => r.ok).length);

const sourceTone = { manual: "neutral", scheduled: "info", auto: "violet" } as const;

/** What came back, in the viewer's language: the text for text-like kinds, a media summary otherwise. */
function outcomeOf(r: AccountTestRun): string {
  if (!r.ok) {
    const key = r.code ? `accounts.test.errors.${r.code}` : "";
    const message = r.message || r.code;
    return key && te(key) ? t(key, { message }) : message || t("accounts.test.errors.unknown");
  }
  switch (r.kind) {
    case "image":
      return t("accounts.test.history.images", { n: r.mediaCount });
    case "embedding":
      return t("accounts.test.history.dimensions", { n: r.dimensions ?? 0 });
    case "speech":
      return t("accounts.test.history.audio");
    case "video":
      return r.mediaCount > 0 ? t("accounts.test.history.videoReady") : r.output;
    default:
      return r.output;
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs text-fg-muted">
        <template v-if="runs.length">{{ t("accounts.test.history.summary", { total: runs.length, ok: passed }) }} · </template>
        {{ t("accounts.test.history.retention", { n: ACCOUNT_TEST_HISTORY_LIMIT }) }}
      </p>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || !accountId" @click="reload">
        <UiIcon name="refresh" :size="13" :spin="loading" />
        {{ t("accounts.test.history.refresh") }}
      </button>
    </div>

    <p v-if="error" class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
      {{ t("accounts.test.history.loadFailed", { message: error }) }}
    </p>

    <div v-if="loaded && runs.length === 0" class="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <UiIcon name="clock" :size="20" class="mx-auto text-fg-subtle" />
      <p class="mt-2 text-sm font-medium text-fg">{{ t("accounts.test.history.empty") }}</p>
      <p class="mx-auto mt-1 max-w-sm text-xs text-fg-muted">{{ t("accounts.test.history.emptyHint", { n: ACCOUNT_TEST_HISTORY_LIMIT }) }}</p>
    </div>

    <ol v-else-if="runs.length" class="max-h-[22rem] divide-y divide-line overflow-y-auto rounded-xl border border-line">
      <li v-for="r in runs" :key="r.id" class="flex gap-3 px-3 py-2.5">
        <span
          class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          :class="r.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'"
          :aria-label="r.ok ? t('accounts.test.history.passed') : t('accounts.test.history.failed')"
          role="img"
        >
          <UiIcon :name="r.ok ? 'check' : 'x'" :size="12" :stroke-width="2.5" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-xs font-medium text-fg" :title="formatDateTime(r.atIso)">{{ formatRelative(r.atIso, now) }}</span>
            <UiBadge :tone="sourceTone[r.source]">{{ t(`accounts.test.history.sources.${r.source}`) }}</UiBadge>
            <UiBadge tone="neutral">{{ t(`accounts.test.kinds.${r.kind}`) }}</UiBadge>
            <span v-if="r.model" class="min-w-0 truncate font-mono text-2xs text-fg-muted" :title="r.model">{{ r.model }}</span>
            <span class="ml-auto shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
              <template v-if="r.status">{{ r.status }} · </template>{{ formatDurationMs(r.durationMs) }}<template v-if="r.ttftMs"> · {{ t("accounts.test.history.ttft", { ttft: formatDurationMs(r.ttftMs) }) }}</template>
            </span>
          </div>
          <p
            v-if="outcomeOf(r)"
            class="mt-1 line-clamp-2 break-words text-xs"
            :class="r.ok ? 'text-fg-muted' : 'text-danger'"
            :title="outcomeOf(r)"
          >
            {{ outcomeOf(r) }}
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>
