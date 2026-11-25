<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ACCOUNT_TEST_MODELS, type AccountTestEvent, type UpstreamAccount } from "@slipgate/contracts";
import CopyButton from "../ui/CopyButton.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import { PROVIDER_OPTIONS, accountStatusLabel, executionModeLabel, healthTone } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const props = defineProps<{
  open: boolean;
  account: UpstreamAccount | null;
}>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "tested"): void;
}>();

const { t, te } = useI18n();
const auth = useAuthStore();

type LineKind = "info" | "ok" | "error" | "text";
interface OutputLine {
  kind: LineKind;
  text: string;
}

const model = ref("");
const prompt = ref("");
const running = ref(false);
const hasRun = ref(false);
const lines = ref<OutputLine[]>([]);
const terminal = ref<HTMLElement | null>(null);
let controller: AbortController | null = null;

const isVm = computed(() => props.account?.executionMode === "vm_slot");
const modelSuggestions = computed(() => (props.account ? (ACCOUNT_TEST_MODELS[props.account.platform] ?? []) : []));
const datalistId = computed(() => `test-models-${props.account?.id ?? "none"}`);
const platformLabel = computed(
  () => PROVIDER_OPTIONS.find((p) => p.value === props.account?.platform)?.label ?? props.account?.platform ?? "",
);
const outputText = computed(() => lines.value.map((l) => l.text).join("\n"));

function reset() {
  lines.value = [];
  hasRun.value = false;
  prompt.value = "";
  model.value = modelSuggestions.value[0] ?? "";
}

function push(kind: LineKind, text: string) {
  lines.value.push({ kind, text });
}

function appendText(text: string) {
  const last = lines.value[lines.value.length - 1];
  if (last && last.kind === "text") {
    last.text += text;
  } else {
    push("text", text);
  }
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function friendlyError(code: string | undefined, message: string | undefined): string {
  const raw = message?.trim() || "";
  if (code) {
    const key = `accounts.test.errors.${code}`;
    if (te(key)) return t(key, { message: raw || code });
  }
  return raw || code || t("accounts.test.errors.unknown");
}

function handleEvent(ev: AccountTestEvent): boolean {
  switch (ev.type) {
    case "start":
      push("info", t("accounts.test.connected", { model: ev.model ?? model.value }));
      return false;
    case "delta":
      if (ev.text) appendText(ev.text);
      return false;
    case "done":
      if (ev.success) {
        push(
          "ok",
          t("accounts.test.success", {
            duration: formatMs(ev.durationMs),
            ttft: formatMs(ev.ttftMs),
            input: ev.inputTokens ?? 0,
            output: ev.outputTokens ?? 0,
          }),
        );
      } else if (ev.status) {
        push("error", t("accounts.test.failed", { status: ev.status, message: friendlyError(ev.code, ev.message) }));
      } else {
        push("error", t("accounts.test.failedNoStatus", { message: friendlyError(ev.code, ev.message) }));
      }
      return true;
    case "error":
      push("error", t("accounts.test.failedNoStatus", { message: friendlyError(ev.code, ev.message) }));
      return true;
    default:
      return false;
  }
}

async function start() {
  const account = props.account;
  if (!account || running.value || isVm.value) return;
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;
  running.value = true;
  hasRun.value = true;
  lines.value = [];
  push("info", t("accounts.test.connecting"));

  let finished = false;
  try {
    const res = await fetch(`/api/v1/admin/accounts/${encodeURIComponent(account.id)}/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        model: model.value.trim() || undefined,
        prompt: prompt.value.trim() || undefined,
      }),
      signal: ctl.signal,
    });
    if (res.status === 401) {
      auth.logout();
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !contentType.includes("text/event-stream")) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      push("error", t("accounts.test.failedNoStatus", { message: friendlyError(payload.error, payload.message) }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        try {
          if (handleEvent(JSON.parse(line.slice(5).trim()) as AccountTestEvent)) finished = true;
        } catch {
          // Ignore malformed lines; the stream continues.
        }
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(`${decoder.decode()}\n`);
    if (!finished) {
      push("error", t("accounts.test.failedNoStatus", { message: friendlyError("stream_interrupted", "EOF") }));
    }
  } catch (err) {
    if (ctl.signal.aborted) {
      push("info", t("accounts.test.stopped"));
    } else {
      push(
        "error",
        t("accounts.test.failedNoStatus", { message: friendlyError(undefined, err instanceof Error ? err.message : String(err)) }),
      );
    }
  } finally {
    if (controller === ctl) controller = null;
    running.value = false;
    if (finished) emit("tested");
  }
}

function stop() {
  controller?.abort();
}

function setOpen(value: boolean) {
  if (!value) stop();
  emit("update:open", value);
}

watch(
  () => [props.open, props.account?.id] as const,
  ([open]) => {
    if (open) {
      reset();
    } else {
      stop();
    }
  },
);

watch(
  lines,
  async () => {
    await nextTick();
    if (terminal.value) terminal.value.scrollTop = terminal.value.scrollHeight;
  },
  { deep: true },
);

onBeforeUnmount(() => stop());

const lineClass: Record<LineKind, string> = {
  info: "text-slate-400",
  ok: "text-emerald-400",
  error: "text-rose-400",
  text: "whitespace-pre-wrap break-words text-slate-100",
};
</script>

<template>
  <UiModal :open="open" :title="t('accounts.test.title')" width="lg" @update:open="setOpen">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon name="play" :size="15" />
      </span>
    </template>

    <div v-if="account" class="space-y-4">
      <div class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2/50 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-fg">{{ account.name }}</p>
          <p class="mt-0.5 truncate text-xs text-fg-muted">{{ account.groupName || t("accounts.ungrouped") }} · {{ executionModeLabel(account.executionMode) }}</p>
        </div>
        <UiBadge tone="accent">{{ platformLabel }}</UiBadge>
        <UiBadge :tone="healthTone(account.status)" dot>{{ accountStatusLabel(account.status) }}</UiBadge>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block min-w-0">
          <span class="label">{{ t("accounts.test.model") }}</span>
          <input
            v-model="model"
            type="text"
            class="input font-mono text-xs"
            :list="datalistId"
            :disabled="running"
            spellcheck="false"
            autocomplete="off"
          />
          <datalist :id="datalistId">
            <option v-for="m in modelSuggestions" :key="m" :value="m" />
          </datalist>
        </label>
        <label class="block min-w-0">
          <span class="label">{{ t("accounts.test.prompt") }}</span>
          <input v-model="prompt" type="text" class="input" placeholder="Hi" :disabled="running" />
        </label>
      </div>

      <div
        ref="terminal"
        class="h-64 overflow-y-auto rounded-xl border border-slate-800 bg-[#0b1020] px-4 py-3 font-mono text-xs leading-relaxed shadow-inner"
        role="log"
        aria-live="polite"
      >
        <p v-if="lines.length === 0" class="text-slate-500">
          $ <span class="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-slate-500" />
        </p>
        <p v-for="(line, i) in lines" :key="i" :class="lineClass[line.kind]">
          <span v-if="line.kind === 'ok'">✓ </span>
          <span v-else-if="line.kind === 'error'">✗ </span>
          <span v-else-if="line.kind === 'info'">› </span>
          {{ line.text }}<span
            v-if="running && i === lines.length - 1"
            class="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-emerald-400"
          />
        </p>
      </div>
    </div>

    <template #footer>
      <CopyButton v-if="lines.length > 0" :text="outputText" :label="t('accounts.test.copy')" size="sm" class="mr-auto" />
      <button v-if="running" type="button" class="btn btn-secondary" @click="stop">
        <UiIcon name="stop" :size="14" />
        {{ t("accounts.test.stop") }}
      </button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="running || isVm || !account"
        :title="isVm ? t('accounts.row.vmTestDisabled') : undefined"
        @click="start"
      >
        <UiIcon :name="running ? 'loader' : hasRun ? 'refresh' : 'play'" :size="14" :spin="running" />
        {{ running ? t("accounts.test.running") : hasRun ? t("accounts.test.retest") : t("accounts.test.start") }}
      </button>
    </template>
  </UiModal>
</template>
