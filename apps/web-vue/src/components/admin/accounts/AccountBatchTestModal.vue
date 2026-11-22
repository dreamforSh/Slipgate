<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UpstreamAccount } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { runPool, streamAccountTest, type AccountTestFinal } from "../../../lib/accountTestStream";
import { formatDurationMs, type Tone } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";

/**
 * Connectivity tests for many accounts through the data plane, a few at a time. Results are
 * persisted per account by the BFF; the parent refreshes the list when this finishes.
 */
const props = defineProps<{
  open: boolean;
  accounts: UpstreamAccount[];
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "finished"): void }>();

const CONCURRENCY = 3;

const { t, te } = useI18n();
const auth = useAuthStore();

type RowState = "pending" | "running" | "ok" | "failed" | "stopped";
interface Row {
  id: string;
  name: string;
  state: RowState;
  message: string;
  durationMs: number | null;
}

const rows = ref<Row[]>([]);
const running = ref(false);
const started = ref(false);
let controller: AbortController | null = null;

const testable = computed(() => props.accounts.filter((a) => a.executionMode !== "vm_slot"));
const skippedVm = computed(() => props.accounts.length - testable.value.length);
const done = computed(() => rows.value.filter((r) => r.state === "ok" || r.state === "failed").length);
const okCount = computed(() => rows.value.filter((r) => r.state === "ok").length);
const failedCount = computed(() => rows.value.filter((r) => r.state === "failed").length);
const progressPct = computed(() => (rows.value.length ? (done.value / rows.value.length) * 100 : 0));

const STATE_TONE: Record<RowState, Tone> = {
  pending: "neutral",
  running: "info",
  ok: "success",
  failed: "danger",
  stopped: "neutral",
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      started.value = false;
      rows.value = testable.value.map((a) => ({ id: a.id, name: a.name, state: "pending", message: "", durationMs: null }));
    } else {
      stop();
    }
  },
);

function describe(final: AccountTestFinal): { ok: boolean; message: string; durationMs: number | null } {
  if (final.kind === "done") {
    const ev = final.event;
    const ok = ev.type === "done" && ev.success === true;
    let message = "";
    if (!ok) {
      const key = ev.code ? `accounts.test.errors.${ev.code}` : "";
      const raw = ev.message ?? ev.code ?? (ev.status ? `HTTP ${ev.status}` : "");
      message = key && te(key) ? t(key, { message: raw }) : raw;
      if (ev.status && !message.includes(String(ev.status))) message = `HTTP ${ev.status} · ${message}`;
    }
    return { ok, message, durationMs: ev.durationMs ?? null };
  }
  if (final.kind === "rejected") {
    const key = final.code ? `accounts.test.errors.${final.code}` : "";
    const raw = final.message ?? final.code ?? "";
    return { ok: false, message: key && te(key) ? t(key, { message: raw }) : raw, durationMs: null };
  }
  if (final.kind === "interrupted") {
    return { ok: false, message: t("accounts.test.errors.stream_interrupted", { message: "EOF" }), durationMs: null };
  }
  return { ok: false, message: "", durationMs: null };
}

async function run(targets: Row[]) {
  if (running.value || !targets.length) return;
  started.value = true;
  running.value = true;
  const ctl = new AbortController();
  controller = ctl;
  for (const row of targets) {
    row.state = "pending";
    row.message = "";
    row.durationMs = null;
  }
  try {
    await runPool(
      targets,
      CONCURRENCY,
      async (row) => {
        row.state = "running";
        const final = await streamAccountTest(auth.apiFetch, row.id, {}, { signal: ctl.signal });
        if (final.kind === "aborted") {
          row.state = "stopped";
          return;
        }
        const outcome = describe(final);
        row.state = outcome.ok ? "ok" : "failed";
        row.message = outcome.message;
        row.durationMs = outcome.durationMs;
      },
      ctl.signal,
    );
  } finally {
    for (const row of targets) if (row.state === "pending" || row.state === "running") row.state = "stopped";
    if (controller === ctl) controller = null;
    running.value = false;
    emit("finished");
  }
}

function startAll() {
  void run(rows.value);
}

function retryFailed() {
  void run(rows.value.filter((r) => r.state === "failed" || r.state === "stopped"));
}

function stop() {
  controller?.abort();
}

onBeforeUnmount(stop);
</script>

<template>
  <UiModal :open="open" :title="t('accounts.batchTest.title')" width="lg" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="play" :size="15" /></span>
    </template>
    <div class="space-y-4">
      <p class="text-sm text-fg-muted">
        {{ t("accounts.batchTest.intro", { count: rows.length, limit: CONCURRENCY }) }}
        <span v-if="skippedVm" class="text-fg-subtle">{{ t("accounts.batchTest.skippedVm", { count: skippedVm }) }}</span>
      </p>

      <div v-if="started" class="space-y-1.5">
        <div class="flex items-center justify-between text-xs">
          <span class="font-medium text-fg">{{ t("accounts.batchTest.progress", { done, total: rows.length }) }}</span>
          <span class="text-fg-muted">{{ t("accounts.batchTest.summary", { ok: okCount, failed: failedCount }) }}</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div class="h-full rounded-full bg-accent transition-[width] duration-300" :style="{ width: `${progressPct}%` }" />
        </div>
      </div>

      <ul class="max-h-80 divide-y divide-line/60 overflow-y-auto rounded-lg border border-line/70">
        <li v-for="row in rows" :key="row.id" class="flex min-w-0 items-center gap-3 px-3 py-2">
          <UiIcon
            :name="row.state === 'running' ? 'loader' : row.state === 'ok' ? 'check-circle' : row.state === 'failed' ? 'x-circle' : 'clock'"
            :size="14"
            :spin="row.state === 'running'"
            :class="row.state === 'ok' ? 'text-success' : row.state === 'failed' ? 'text-danger' : 'text-fg-subtle'"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-fg">{{ row.name }}</p>
            <p v-if="row.message" class="truncate text-2xs text-danger" :title="row.message">{{ row.message }}</p>
          </div>
          <span v-if="row.durationMs" class="shrink-0 font-mono text-2xs text-fg-subtle">{{ formatDurationMs(row.durationMs) }}</span>
          <UiBadge :tone="STATE_TONE[row.state]">{{ t(`accounts.batchTest.states.${row.state}`) }}</UiBadge>
        </li>
      </ul>
    </div>
    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.close") }}</button>
      <button v-if="running" type="button" class="btn btn-danger" @click="stop">
        <UiIcon name="stop" :size="13" />
        {{ t("accounts.batchTest.stop") }}
      </button>
      <button
        v-else-if="started && (failedCount > 0 || rows.some((r) => r.state === 'stopped'))"
        type="button"
        class="btn btn-primary"
        @click="retryFailed"
      >
        <UiIcon name="refresh" :size="13" />
        {{ t("accounts.batchTest.retryFailed") }}
      </button>
      <button v-else-if="!started" type="button" class="btn btn-primary" :disabled="!rows.length" @click="startAll">
        <UiIcon name="play" :size="13" />
        {{ t("accounts.batchTest.start") }}
      </button>
    </template>
  </UiModal>
</template>
