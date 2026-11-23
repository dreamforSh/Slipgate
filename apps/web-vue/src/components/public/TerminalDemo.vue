<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import PlatformIcon from "../ui/PlatformIcon.vue";
import UiIcon from "../ui/UiIcon.vue";
import { prefersReducedMotion } from "./publicUtils";

/**
 * Landing-page terminal: types a curl request against this gateway, waits a beat, then prints
 * a 200 response line by line, and cycles through the Anthropic / OpenAI / Gemini protocols.
 * Pauses while scrolled away or the tab is hidden; renders a static frame under reduced motion.
 * Always drawn with the dark palette (the `dark` class re-scopes the color tokens).
 */
const props = defineProps<{ baseUrl: string }>();
const { t } = useI18n();

type Tok = "prompt" | "cmd" | "url" | "flag" | "str" | "key" | "num" | "lit" | "punct" | "dim" | "plain" | "ok";
interface Seg {
  text: string;
  tok: Tok;
}
type Line = Seg[];
interface Scene {
  key: string;
  label: string;
  platform: string;
  path: string;
  command: Line[];
  response: Line[];
  meta: string;
}

const TOK_CLASS: Record<Tok, string> = {
  prompt: "text-accent",
  cmd: "font-semibold text-fg",
  url: "text-info",
  flag: "text-violet",
  str: "text-success",
  key: "text-accent",
  num: "text-warning",
  lit: "text-violet",
  punct: "text-fg-subtle",
  dim: "text-fg-subtle",
  plain: "text-fg-muted",
  ok: "font-semibold text-success",
};

const MASKED_KEY = "sk-sg-••••••••••••••••";

/** Splits one line of JSON into colored segments (keys, strings, numbers, literals, punctuation). */
function jsonLine(text: string): Line {
  const out: Line = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b|([{}[\],])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), tok: "plain" });
    if (m[1]) {
      out.push({ text: m[1], tok: m[2] ? "key" : "str" });
      if (m[2]) out.push({ text: m[2], tok: "punct" });
    } else if (m[3]) out.push({ text: m[3], tok: "num" });
    else if (m[4]) out.push({ text: m[4], tok: "lit" });
    else out.push({ text: m[5] ?? "", tok: "punct" });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), tok: "plain" });
  return out;
}

function curl(path: string, headers: [string, string][], body: string[]): Line[] {
  const lines: Line[] = [
    [
      { text: "$ ", tok: "prompt" },
      { text: "curl ", tok: "cmd" },
      { text: `${props.baseUrl}${path}`, tok: "url" },
      { text: " \\", tok: "dim" },
    ],
  ];
  for (const [k, v] of headers) {
    lines.push([{ text: "  -H ", tok: "flag" }, { text: `"${k}: ${v}"`, tok: "str" }, { text: " \\", tok: "dim" }]);
  }
  body.forEach((b, i) => {
    const segs = jsonLine(`  ${b}`);
    if (i === 0) lines.push([{ text: "  -d ", tok: "flag" }, { text: "'", tok: "str" }, ...jsonLine(b)]);
    else if (i === body.length - 1) lines.push([...segs, { text: "'", tok: "str" }]);
    else lines.push(segs);
  });
  return lines;
}

function response(json: string[]): Line[] {
  return [[{ text: "HTTP/1.1 ", tok: "dim" }, { text: "200 OK", tok: "ok" }], ...json.map(jsonLine)];
}

const scenes = computed<Scene[]>(() => {
  const prompt = JSON.stringify(t("public.home.terminal.prompt"));
  const reply = JSON.stringify(t("public.home.terminal.reply"));
  const json = { "Content-Type": "application/json" };
  return [
    {
      key: "anthropic",
      label: "Claude",
      platform: "anthropic",
      path: "/v1/messages",
      command: curl(
        "/v1/messages",
        [
          ["x-api-key", MASKED_KEY],
          ["anthropic-version", "2023-06-01"],
          ["content-type", json["Content-Type"]],
        ],
        ["{", `  "model": "claude-sonnet-5-5",`, `  "max_tokens": 256,`, `  "messages": [{ "role": "user", "content": ${prompt} }]`, "}"],
      ),
      response: response([
        "{",
        `  "id": "msg_01J8ZQ4N7XK2",`,
        `  "type": "message",`,
        `  "role": "assistant",`,
        `  "model": "claude-sonnet-5-5",`,
        `  "content": [{ "type": "text", "text": ${reply} }],`,
        `  "stop_reason": "end_turn",`,
        `  "usage": { "input_tokens": 21, "output_tokens": 34 }`,
        "}",
      ]),
      meta: "1.21 s · $0.000573",
    },
    {
      key: "openai",
      label: "OpenAI",
      platform: "openai",
      path: "/v1/chat/completions",
      command: curl(
        "/v1/chat/completions",
        [
          ["Authorization", `Bearer ${MASKED_KEY}`],
          ["Content-Type", json["Content-Type"]],
        ],
        ["{", `  "model": "gpt-5.5",`, `  "messages": [{ "role": "user", "content": ${prompt} }]`, "}"],
      ),
      response: response([
        "{",
        `  "id": "chatcmpl-9xQ2b7Lk",`,
        `  "object": "chat.completion",`,
        `  "model": "gpt-5.5",`,
        `  "choices": [{`,
        `    "message": { "role": "assistant", "content": ${reply} },`,
        `    "finish_reason": "stop"`,
        `  }],`,
        `  "usage": { "prompt_tokens": 19, "completion_tokens": 31 }`,
        "}",
      ]),
      meta: "0.94 s · $0.000412",
    },
    {
      key: "gemini",
      label: "Gemini",
      platform: "gemini",
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      command: curl(
        "/v1beta/models/gemini-2.5-pro:generateContent",
        [
          ["x-goog-api-key", MASKED_KEY],
          ["Content-Type", json["Content-Type"]],
        ],
        ["{", `  "contents": [{ "role": "user", "parts": [{ "text": ${prompt} }] }]`, "}"],
      ),
      response: response([
        "{",
        `  "candidates": [{`,
        `    "content": { "role": "model", "parts": [{ "text": ${reply} }] },`,
        `    "finishReason": "STOP"`,
        `  }],`,
        `  "usageMetadata": { "promptTokenCount": 17, "candidatesTokenCount": 29 },`,
        `  "modelVersion": "gemini-2.5-pro"`,
        "}",
      ]),
      meta: "1.08 s · $0.000311",
    },
  ];
});

const index = ref(0);
const scene = computed(() => scenes.value[index.value] ?? scenes.value[0]!);
const typed = ref(0);
const responseCount = ref(0);
const phase = ref<"typing" | "pending" | "done">("typing");
const fading = ref(false);
const host = computed(() => {
  try {
    return new URL(props.baseUrl).host;
  } catch {
    return "gateway";
  }
});

const lineLength = (line: Line) => line.reduce((n, s) => n + s.text.length, 0);
const commandLength = computed(() => scene.value.command.reduce((n, l) => n + lineLength(l) + 1, 0));

/** The command as typed so far; each line break counts as one character. */
const visibleCommand = computed(() => {
  let budget = typed.value;
  const out: Line[] = [];
  for (const line of scene.value.command) {
    if (budget <= 0) break;
    const segs: Line = [];
    for (const s of line) {
      if (budget <= 0) break;
      const part = s.text.slice(0, budget);
      segs.push({ text: part, tok: s.tok });
      budget -= part.length;
    }
    out.push(segs);
    budget -= 1;
  }
  return out;
});
const visibleResponse = computed(() => scene.value.response.slice(0, responseCount.value));

/* ---------------- Playback ---------------- */

const root = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const inView = ref(true);
const pageVisible = ref(true);
const reduced = ref(false);
let runId = 0;
let observer: IntersectionObserver | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Waits while the terminal is off-screen or the tab is hidden; false once the run is superseded. */
async function gate(id: number): Promise<boolean> {
  while (id === runId && !(inView.value && pageVisible.value)) await sleep(300);
  return id === runId;
}

function showStatic(i: number) {
  runId += 1;
  index.value = i;
  fading.value = false;
  typed.value = commandLength.value;
  responseCount.value = scene.value.response.length;
  phase.value = "done";
}

async function play(start: number) {
  const id = ++runId;
  let i = start;
  while (id === runId) {
    index.value = i;
    typed.value = 0;
    responseCount.value = 0;
    phase.value = "typing";
    fading.value = false;
    await sleep(450);
    while (typed.value < commandLength.value) {
      if (!(await gate(id))) return;
      typed.value = Math.min(commandLength.value, typed.value + 2);
      await sleep(14 + Math.random() * 18);
    }
    if (!(await gate(id))) return;
    phase.value = "pending";
    await sleep(750);
    for (let k = 1; k <= scene.value.response.length; k++) {
      if (!(await gate(id))) return;
      if (k === 1) phase.value = "done";
      responseCount.value = k;
      await sleep(70);
    }
    await sleep(5200);
    if (!(await gate(id))) return;
    fading.value = true;
    await sleep(380);
    i = (i + 1) % scenes.value.length;
  }
}

function select(i: number) {
  if (reduced.value) showStatic(i);
  else void play(i);
}

function onVisibility() {
  pageVisible.value = document.visibilityState !== "hidden";
}

// Keep the newest line in view, like a real terminal.
watch([typed, responseCount], () => {
  void nextTick(() => {
    const el = body.value;
    if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  });
});

onMounted(() => {
  reduced.value = prefersReducedMotion();
  if (reduced.value) {
    showStatic(0);
    return;
  }
  document.addEventListener("visibilitychange", onVisibility);
  onVisibility();
  if (root.value && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((entries) => {
      inView.value = entries.some((e) => e.isIntersecting);
    });
    observer.observe(root.value);
  }
  void play(0);
});

onBeforeUnmount(() => {
  runId += 1;
  observer?.disconnect();
  document.removeEventListener("visibilitychange", onVisibility);
});
</script>

<template>
  <div ref="root" class="dark relative" role="region" :aria-label="t('public.home.terminal.label')">
    <div class="terminal-glow pointer-events-none absolute -inset-6 rounded-[2.5rem] blur-2xl" aria-hidden="true" />
    <div class="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-pop ring-1 ring-white/5">
      <!-- Title bar -->
      <div class="flex items-center gap-3 border-b border-line/80 bg-surface-2/60 px-4 py-2.5">
        <div class="flex gap-1.5" aria-hidden="true">
          <span class="h-2.5 w-2.5 rounded-full bg-danger/80" />
          <span class="h-2.5 w-2.5 rounded-full bg-warning/80" />
          <span class="h-2.5 w-2.5 rounded-full bg-success/80" />
        </div>
        <p class="min-w-0 flex-1 truncate text-center font-mono text-2xs text-fg-subtle">
          {{ t("public.home.terminal.title") }} — {{ host }}
        </p>
        <span class="w-[42px]" aria-hidden="true" />
      </div>

      <!-- Protocol tabs -->
      <div class="flex items-center gap-1 border-b border-line/60 px-3 py-2" role="group" :aria-label="t('public.home.terminal.scenes')">
        <button
          v-for="(s, i) in scenes"
          :key="s.key"
          type="button"
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-2xs font-medium transition-colors duration-150"
          :class="i === index ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/25' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg'"
          :aria-pressed="i === index"
          @click="select(i)"
        >
          <PlatformIcon :platform="s.platform" :size="12" />
          {{ s.label }}
        </button>
      </div>

      <!-- Body -->
      <div
        ref="body"
        class="terminal-body scrollbar-hide h-[24rem] overflow-y-auto px-4 py-4 font-mono text-[11px] leading-[1.75] transition-opacity duration-300 sm:h-[26rem] sm:text-[12.5px]"
        :class="fading ? 'opacity-0' : 'opacity-100'"
        aria-live="off"
      >
        <div v-for="(line, li) in visibleCommand" :key="`c${index}-${li}`" class="whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span v-for="(s, si) in line" :key="si" :class="TOK_CLASS[s.tok]">{{ s.text }}</span>
          <span v-if="phase === 'typing' && li === visibleCommand.length - 1" class="caret" aria-hidden="true" />
        </div>
        <div v-if="phase === 'typing' && visibleCommand.length === 0">
          <span :class="TOK_CLASS.prompt">$ </span><span class="caret" aria-hidden="true" />
        </div>

        <p v-if="phase === 'pending'" class="mt-3 flex items-center gap-2 text-fg-subtle">
          <UiIcon name="loader" :size="13" spin />
          {{ t("public.home.terminal.pending") }}
        </p>

        <div v-if="visibleResponse.length" class="mt-3">
          <div
            v-for="(line, li) in visibleResponse"
            :key="`r${index}-${li}`"
            class="line-in whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            <span v-for="(s, si) in line" :key="si" :class="TOK_CLASS[s.tok]">{{ s.text }}</span>
          </div>
        </div>
      </div>

      <!-- Status bar -->
      <div class="flex items-center justify-between gap-3 border-t border-line/60 bg-surface-2/40 px-4 py-2 font-mono text-2xs text-fg-subtle">
        <span class="min-w-0 truncate"><span class="font-semibold text-accent">POST</span> {{ scene.path }}</span>
        <Transition
          enter-active-class="transition duration-300 ease-out"
          enter-from-class="opacity-0 translate-x-1"
          leave-active-class="transition duration-150"
          leave-to-class="opacity-0"
        >
          <span v-if="phase === 'done' && !fading" class="inline-flex shrink-0 items-center gap-1.5 text-success">
            <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            200 · {{ scene.meta }}
          </span>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-glow {
  background:
    radial-gradient(60% 60% at 70% 20%, rgb(var(--accent-glow) / 0.28), transparent 70%),
    radial-gradient(50% 50% at 20% 90%, rgb(var(--info) / 0.16), transparent 70%);
}
.terminal-body {
  background-image: radial-gradient(120% 80% at 100% 0%, rgb(var(--accent-glow) / 0.06), transparent 60%);
}
.caret {
  display: inline-block;
  width: 0.55em;
  height: 1.15em;
  margin-left: 1px;
  vertical-align: -0.2em;
  background: rgb(var(--accent));
  animation: caret-blink 1s steps(1) infinite;
}
.line-in {
  animation: line-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}
@keyframes line-in {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret,
  .line-in {
    animation: none;
  }
}
</style>
