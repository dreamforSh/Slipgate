<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ACCOUNT_TEST_MAX_UPLOAD_BYTES,
  accountTestKinds,
  accountTestUploads,
  type AccountTestEvent,
  type AccountTestKind,
  type UpstreamAccount,
} from "@slipgate/contracts";
import CopyButton from "../ui/CopyButton.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiTabs from "../ui/UiTabs.vue";
import AccountTestHistory from "./accounts/AccountTestHistory.vue";
import { PROVIDER_OPTIONS, accountStatusLabel, executionModeLabel, healthTone } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { useAccountModels } from "./accounts/accountModels";

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
/** Endpoint the test calls (sub2api-style split): text, image, embedding, speech, transcription or video. */
const kind = ref<AccountTestKind>("text");
/** Images / audio / video the test produced. */
const media = ref<{ kind: AccountTestKind; url: string; mime: string }[]>([]);
/** Latest progress of a video task (percent; null = none reported). */
const progress = ref<number | null>(null);
/** The video job was accepted but was still rendering when the test ended. */
const videoPending = ref(false);
const tab = ref<"test" | "history">("test");
const historyCount = ref<number | null>(null);
const history = ref<InstanceType<typeof AccountTestHistory> | null>(null);

/* ---------------- Uploads (a source image or audio, as data: URLs) ---------------- */
interface Upload {
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
}
const imageUpload = ref<Upload | null>(null);
const audioUpload = ref<Upload | null>(null);
const uploadError = ref("");
const uploads = computed(() => accountTestUploads(props.account?.platform ?? "", kind.value));
const maxUploadMb = ACCOUNT_TEST_MAX_UPLOAD_BYTES / 1024 / 1024;

function readFile(file: File, type: "image" | "audio"): Promise<Upload | null> {
  uploadError.value = "";
  const okType = type === "image" ? file.type.startsWith("image/") : file.type.startsWith("audio/") || file.type === "video/mp4" || file.type === "video/webm";
  if (!okType) {
    uploadError.value = t("accounts.test.upload.wrongType", { type: t(type === "image" ? "accounts.test.upload.typeImage" : "accounts.test.upload.typeAudio") });
    return Promise.resolve(null);
  }
  if (file.size > ACCOUNT_TEST_MAX_UPLOAD_BYTES) {
    uploadError.value = t("accounts.test.upload.tooLarge", { max: maxUploadMb });
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mime: file.type, size: file.size, dataUrl: String(reader.result) });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function onPick(ev: Event, type: "image" | "audio") {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const up = await readFile(file, type);
  if (!up) return;
  if (type === "image") imageUpload.value = up;
  else audioUpload.value = up;
}
const lightbox = ref<string | null>(null);
const running = ref(false);
const hasRun = ref(false);
const lines = ref<OutputLine[]>([]);
const terminal = ref<HTMLElement | null>(null);
let controller: AbortController | null = null;

const isVm = computed(() => props.account?.executionMode === "vm_slot");
const kinds = computed(() => accountTestKinds(props.account?.platform ?? ""));
const kindOptions = computed(() =>
  kinds.value.map((k) => ({ value: k, label: t(`accounts.test.kinds.${k}`), disabled: running.value && k !== kind.value })),
);
const models = useAccountModels();

/** Which listed models fit a test kind (by name): image / embedding / speech / … models vs the rest. */
const KIND_PATTERNS: Record<Exclude<AccountTestKind, "text">, RegExp> = {
  image: /image|imagen|dall-e/i,
  embedding: /embed/i,
  speech: /tts|speech/i,
  transcription: /whisper|transcri/i,
  video: /sora|video|veo/i,
};
function fitsKind(id: string, k: AccountTestKind): boolean {
  if (k !== "text") return KIND_PATTERNS[k].test(id);
  return !Object.values(KIND_PATTERNS).some((re) => re.test(id));
}
const modelSuggestions = computed(() => models.suggestions(props.account?.platform).filter((m) => fitsKind(m, kind.value)));
const promptPlaceholder = computed(() => t(`accounts.test.promptPlaceholder.${kind.value}`));

async function fetchModels() {
  const account = props.account;
  if (!account || models.loading.value) return;
  const answer = await models.load(account.id);
  // Keep a model the admin typed; otherwise start from the first listed one.
  if (answer && !model.value.trim()) model.value = modelSuggestions.value[0] ?? "";
}
const datalistId = computed(() => `test-models-${props.account?.id ?? "none"}`);
const platformLabel = computed(
  () => PROVIDER_OPTIONS.find((p) => p.value === props.account?.platform)?.label ?? props.account?.platform ?? "",
);
const outputText = computed(() => lines.value.map((l) => l.text).join("\n"));

function reset() {
  lines.value = [];
  media.value = [];
  progress.value = null;
  videoPending.value = false;
  lightbox.value = null;
  hasRun.value = false;
  prompt.value = "";
  kind.value = "text";
  tab.value = "test";
  historyCount.value = null;
  imageUpload.value = null;
  audioUpload.value = null;
  uploadError.value = "";
  models.show(props.account?.id);
  model.value = modelSuggestions.value[0] ?? "";
}

// A new kind starts from a model that fits it (or the server's default for that kind).
watch(kind, () => {
  if (!fitsKind(model.value, kind.value)) model.value = modelSuggestions.value[0] ?? "";
  media.value = [];
  progress.value = null;
  videoPending.value = false;
  uploadError.value = "";
});

function formatBytes(dataUrl: string): string {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Math.floor((b64.length * 3) / 4);
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
      push("info", t("accounts.test.connected", { model: ev.model ?? model.value, kind: t(`accounts.test.kinds.${ev.kind ?? kind.value}`) }));
      return false;
    case "media":
      if (ev.mediaUrl) {
        media.value.push({ kind: ev.kind ?? kind.value, url: ev.mediaUrl, mime: ev.mimeType ?? "" });
        push("info", t("accounts.test.mediaReceived", { mime: ev.mimeType || "-", size: ev.mediaUrl.startsWith("data:") ? formatBytes(ev.mediaUrl) : "URL" }));
      }
      return false;
    case "delta":
      if (ev.text) appendText(ev.text);
      return false;
    case "progress":
      if (ev.text) {
        const pct = typeof ev.progress === "number" && ev.progress > 0 ? Math.round(ev.progress) : null;
        if (pct !== null) progress.value = pct;
        if (/still rendering/i.test(ev.text)) videoPending.value = true;
        push("info", pct !== null ? t("accounts.test.progressPercent", { text: ev.text, percent: pct }) : t("accounts.test.progress", { text: ev.text }));
      }
      return false;
    case "done":
      if (ev.success && (ev.kind ?? "text") !== "text") {
        const k = ev.kind ?? kind.value;
        const duration = formatMs(ev.durationMs);
        if (k === "video" && !videoPending.value) progress.value = 100;
        push(
          "ok",
          k === "embedding"
            ? t("accounts.test.successEmbedding", { dims: ev.dimensions ?? 0, input: ev.inputTokens ?? 0, duration })
            : k === "image"
              ? t("accounts.test.successImage", { n: media.value.length, duration })
              : k === "transcription"
                ? t("accounts.test.successTranscription", { duration })
                : k === "video"
                  ? t(videoPending.value ? "accounts.test.successVideoPending" : "accounts.test.successVideo", { duration })
                  : t("accounts.test.successSpeech", { duration }),
        );
      } else if (ev.success) {
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
  media.value = [];
  progress.value = null;
  videoPending.value = false;
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
        kind: kind.value === "text" ? undefined : kind.value,
        model: model.value.trim() || undefined,
        prompt: prompt.value.trim() || undefined,
        imageDataUrl: uploads.value.image ? imageUpload.value?.dataUrl : undefined,
        audioDataUrl: uploads.value.audio ? audioUpload.value?.dataUrl : undefined,
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
    // The BFF records the run as the stream closes; refresh the history once it has.
    void history.value?.reload();
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

      <UiTabs
        v-model="tab"
        :tabs="[
          { key: 'test', label: t('accounts.test.tabs.test'), icon: 'play' },
          { key: 'history', label: t('accounts.test.tabs.history'), icon: 'clock', count: historyCount ?? undefined },
        ]"
      />

      <AccountTestHistory v-show="tab === 'history'" ref="history" :account-id="open ? account.id : null" @count="historyCount = $event" />

      <div v-show="tab === 'test'" class="space-y-4">
      <div v-if="kinds.length > 1" class="flex flex-wrap items-center justify-between gap-2">
        <span class="label !mb-0">{{ t("accounts.test.kind") }}</span>
        <div class="max-w-full overflow-x-auto">
          <SegmentedControl v-model="kind" :options="kindOptions" :aria-label="t('accounts.test.kind')" />
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="min-w-0">
          <div class="label flex items-center justify-between gap-2">
            <label :for="`${datalistId}-input`">{{ t("accounts.test.model") }}</label>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="running || isVm || models.loading.value"
              @click="fetchModels"
            >
              <UiIcon :name="models.loading.value ? 'loader' : 'download'" :size="11" :spin="models.loading.value" />
              {{ models.result.value ? t("accounts.models.refetch") : t("accounts.models.fetch") }}
            </button>
          </div>
          <input
            :id="`${datalistId}-input`"
            v-model="model"
            type="text"
            class="input font-mono text-xs"
            :list="datalistId"
            :disabled="running"
            :placeholder="t('accounts.test.modelDefault')"
            spellcheck="false"
            autocomplete="off"
          />
          <datalist :id="datalistId">
            <option v-for="m in modelSuggestions" :key="m" :value="m" />
          </datalist>
          <p v-if="models.error.value" class="mt-1 truncate text-2xs text-danger" :title="models.error.value">
            {{ t("accounts.models.failed", { message: models.error.value }) }}
          </p>
          <p
            v-else-if="models.result.value"
            class="mt-1 truncate text-2xs"
            :class="models.result.value.source === 'upstream' ? 'text-fg-subtle' : 'text-warning'"
            :title="models.result.value.message || undefined"
          >
            {{
              models.result.value.source === "upstream"
                ? t("accounts.models.fromUpstream", { n: models.result.value.models.length })
                : t("accounts.models.fallback", { message: models.result.value.message })
            }}
          </p>
        </div>
        <label class="block min-w-0">
          <span class="label">{{ t(`accounts.test.promptLabel.${kind}`) }}</span>
          <input v-model="prompt" type="text" class="input" :placeholder="promptPlaceholder" :disabled="running" />
        </label>
      </div>

      <!-- Optional upload: a source image (OpenAI image edit / Grok video first frame) or audio to transcribe -->
      <div v-if="uploads.image || uploads.audio" class="rounded-xl border border-dashed border-line px-3 py-2.5">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-xs font-medium text-fg">{{ t(uploads.image ? "accounts.test.upload.image" : "accounts.test.upload.audio") }}</span>
          <template v-if="uploads.image && imageUpload">
            <img :src="imageUpload.dataUrl" alt="" class="h-10 w-10 rounded-md border border-line object-cover" />
            <span class="min-w-0 flex-1 truncate text-2xs text-fg-muted" :title="imageUpload.name">
              {{ imageUpload.name }} · {{ formatBytes(imageUpload.dataUrl) }}
            </span>
          </template>
          <template v-else-if="uploads.audio && audioUpload">
            <audio :src="audioUpload.dataUrl" controls class="h-8 min-w-0 max-w-[14rem] flex-1" />
            <span class="min-w-0 truncate text-2xs text-fg-muted" :title="audioUpload.name">{{ audioUpload.name }} · {{ formatBytes(audioUpload.dataUrl) }}</span>
          </template>
          <span v-else class="flex-1" />
          <label class="btn btn-secondary btn-sm cursor-pointer" :class="running ? 'pointer-events-none opacity-50' : ''">
            <UiIcon name="upload" :size="13" />
            {{ (uploads.image ? imageUpload : audioUpload) ? t("accounts.test.upload.replace") : t("accounts.test.upload.choose") }}
            <input
              type="file"
              class="sr-only"
              :accept="uploads.image ? 'image/png,image/jpeg,image/webp' : 'audio/*,video/mp4,video/webm'"
              :disabled="running"
              @change="onPick($event, uploads.image ? 'image' : 'audio')"
            />
          </label>
          <button
            v-if="uploads.image ? imageUpload : audioUpload"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="running"
            @click="uploads.image ? (imageUpload = null) : (audioUpload = null)"
          >
            <UiIcon name="x" :size="13" />
            {{ t("accounts.test.upload.remove") }}
          </button>
        </div>
        <p class="mt-1.5 text-2xs text-fg-subtle">
          {{
            uploads.audio
              ? t("accounts.test.upload.hintAudio")
              : kind === "video"
                ? t("accounts.test.upload.hintVideoFrame")
                : t("accounts.test.upload.hintImageEdit")
          }}
          · ≤ {{ maxUploadMb }} MB
        </p>
        <p v-if="uploadError" class="mt-1 text-2xs text-danger">{{ uploadError }}</p>
      </div>

      <div v-if="kind === 'video' && progress !== null" class="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
        <div class="h-full rounded-full bg-accent transition-[width] duration-500" :style="{ width: `${progress}%` }" />
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

      <!-- What an image / speech test produced -->
      <div v-if="media.length" class="space-y-2">
        <p class="text-xs font-medium text-fg-muted">{{ t("accounts.test.result") }}</p>
        <div v-if="media.some((m) => m.kind === 'image')" class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <button
            v-for="(m, i) in media.filter((x) => x.kind === 'image')"
            :key="i"
            type="button"
            class="group overflow-hidden rounded-lg border border-line bg-surface-2/50 text-left transition-colors hover:border-accent"
            :title="t('accounts.test.enlarge')"
            @click="lightbox = m.url"
          >
            <img :src="m.url" :alt="t('accounts.test.imageAlt', { n: i + 1 })" class="aspect-square w-full object-cover" />
            <span class="block border-t border-line px-2 py-1 text-2xs text-fg-subtle">{{ m.mime || "image/*" }}</span>
          </button>
        </div>
        <audio v-for="(m, i) in media.filter((x) => x.kind === 'speech')" :key="`a${i}`" :src="m.url" controls class="w-full" />
        <video
          v-for="(m, i) in media.filter((x) => x.kind === 'video')"
          :key="`v${i}`"
          :src="m.url"
          controls
          playsinline
          class="max-h-80 w-full rounded-lg border border-line bg-black"
          :aria-label="t('accounts.test.videoAlt')"
        />
      </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="lightbox"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
        role="dialog"
        :aria-label="t('accounts.test.enlarge')"
        @click.self="lightbox = null"
        @keydown.esc="lightbox = null"
      >
        <button type="button" class="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70" :aria-label="t('common.close')" @click="lightbox = null">
          <UiIcon name="x" :size="18" />
        </button>
        <img :src="lightbox" alt="" class="max-h-full max-w-full rounded-lg shadow-2xl" />
      </div>
    </Teleport>

    <template #footer>
      <CopyButton v-if="lines.length > 0 && tab === 'test'" :text="outputText" :label="t('accounts.test.copy')" size="sm" class="mr-auto" />
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
