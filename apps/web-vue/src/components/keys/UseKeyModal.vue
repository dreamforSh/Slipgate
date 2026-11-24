<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem, GroupItem } from "@slipgate/contracts";
import { usePortalStore } from "../../stores/portal";
import CopyButton from "../ui/CopyButton.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiTabs from "../ui/UiTabs.vue";

/**
 * Copy-paste setup for an API key across popular clients and shells. The full key is only
 * known right after creation; otherwise snippets carry a highlighted placeholder.
 */
const props = defineProps<{
  open: boolean;
  apiKey: ApiKeyItem | null;
  /** Plaintext of this key when it was just created; null afterwards. */
  plaintext: string | null;
  group?: GroupItem | null;
}>();

const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const portal = usePortalStore();

type Client = "claude" | "codex" | "gemini" | "sdk" | "curl";
type Os = "unix" | "cmd" | "powershell";

interface Snippet {
  id: string;
  /** File path or a short caption shown in the snippet header. */
  title: string;
  isFile: boolean;
  content: string;
  hint?: string;
}

const PLACEHOLDER = "sk-sg-xxxxxxxxxxxxxxxx";
const PROVIDER_ID = "slipgate";

const MODEL_BY_PLATFORM: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  codex: "gpt-5-codex",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
  antigravity: "gemini-2.5-pro",
  grok: "grok-4",
  deepseek: "deepseek-chat",
  glm: "glm-4.6",
  kimi: "kimi-k2",
  minimax: "MiniMax-M2",
  qwen: "qwen3-coder-plus",
  bedrock: "anthropic.claude-sonnet-4-5-20250929-v1:0",
  vertex: "gemini-2.5-flash",
  opencode_go: "glm-5.3",
  command_code: "deepseek/deepseek-v4-flash",
  cline: "deepseek/deepseek-v4-flash",
  typesafe: "jev-latest",
};

const CLIENT_ICON: Record<Client, IconName> = {
  claude: "sparkles",
  codex: "braces",
  gemini: "zap",
  sdk: "plug",
  curl: "terminal",
};

const client = ref<Client>("sdk");
const os = ref<Os>("unix");
const model = ref("");

onMounted(() => void portal.load());

function defaultClient(platform: string | undefined): Client {
  switch (platform) {
    case "anthropic":
      return "claude";
    case "codex":
    case "openai":
      return "codex";
    case "gemini":
    case "antigravity":
      return "gemini";
    case "typesafe":
      return "curl";
    default:
      return "sdk";
  }
}

/** Concrete model names from the group's allowlist (wildcard patterns can't be sent as-is). */
const modelOptions = computed(() => (props.group?.modelAllowlist ?? []).filter((m) => m && !/[*?]/.test(m)));

function defaultModel(group: GroupItem | null | undefined): string {
  const listed = group?.modelAllowlist.find((m) => m && !/[*?]/.test(m));
  return listed ?? MODEL_BY_PLATFORM[group?.platform ?? ""] ?? "gpt-5";
}

// Re-seed the tabs for whichever key the dialog opens on.
watch(
  () => [props.open, props.apiKey?.id] as const,
  ([open]) => {
    if (!open) return;
    client.value = defaultClient(props.group?.platform);
    os.value = /windows/i.test(navigator.userAgent) ? "powershell" : "unix";
    model.value = defaultModel(props.group);
  },
  { immediate: true },
);

/* ---------------- Inputs ---------------- */

const baseUrl = computed(() => {
  const raw = (portal.settings?.apiBaseUrl ?? "").trim();
  const abs = !raw ? window.location.origin : raw.startsWith("/") ? `${window.location.origin}${raw}` : raw;
  // The snippets add /v1 themselves where the client expects it.
  return abs.replace(/\/+$/, "").replace(/\/v1$/i, "");
});

const keyValue = computed(() => props.plaintext ?? PLACEHOLDER);
const modelValue = computed(() => model.value.trim() || defaultModel(props.group));
const siteName = computed(() => portal.siteName);
const isWindows = computed(() => os.value !== "unix");

const clientTabs = computed(() =>
  (["claude", "codex", "gemini", "sdk", "curl"] as Client[]).map((key) => ({
    key,
    label: t(`user.useKey.clients.${key}`),
    icon: CLIENT_ICON[key],
  })),
);
const osOptions = computed(() => [
  { value: "unix" as const, label: t("user.useKey.os.unix") },
  { value: "cmd" as const, label: t("user.useKey.os.cmd") },
  { value: "powershell" as const, label: t("user.useKey.os.powershell") },
]);
const showsModel = computed(() => client.value === "codex" || client.value === "sdk" || client.value === "curl");

/* ---------------- Snippet builders ---------------- */

function envBlock(vars: [string, string][]): string {
  switch (os.value) {
    case "cmd":
      return vars.map(([k, v]) => `set ${k}=${v}`).join("\n");
    case "powershell":
      return vars.map(([k, v]) => `$env:${k}="${v}"`).join("\n");
    default:
      return vars.map(([k, v]) => `export ${k}="${v}"`).join("\n");
  }
}

function homePath(...parts: string[]): string {
  return isWindows.value ? `%USERPROFILE%\\${parts.join("\\")}` : `~/${parts.join("/")}`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const snippets = computed<Snippet[]>(() => {
  const base = baseUrl.value;
  const key = keyValue.value;
  const mdl = modelValue.value;
  const persistHint = isWindows.value ? t("user.useKey.hints.persistWindows") : t("user.useKey.hints.persistUnix");

  switch (client.value) {
    case "claude":
      return [
        {
          id: "claude-env",
          title: t("user.useKey.captions.terminal"),
          isFile: false,
          content: `${envBlock([
            ["ANTHROPIC_BASE_URL", base],
            ["ANTHROPIC_AUTH_TOKEN", key],
          ])}\nclaude`,
          hint: t("user.useKey.hints.claudeEnv"),
        },
        {
          id: "claude-settings",
          title: homePath(".claude", "settings.json"),
          isFile: true,
          content: JSON.stringify(
            {
              env: {
                ANTHROPIC_BASE_URL: base,
                ANTHROPIC_AUTH_TOKEN: key,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              },
            },
            null,
            2,
          ),
          hint: t("user.useKey.hints.claudeSettings"),
        },
      ];

    case "codex":
      return [
        {
          id: "codex-config",
          title: homePath(".codex", "config.toml"),
          isFile: true,
          content: [
            `model_provider = ${tomlString(PROVIDER_ID)}`,
            `model = ${tomlString(mdl)}`,
            "",
            `[model_providers.${PROVIDER_ID}]`,
            `name = ${tomlString(siteName.value)}`,
            `base_url = ${tomlString(`${base}/v1`)}`,
            `env_key = "SLIPGATE_API_KEY"`,
            `wire_api = "responses"`,
            `requires_openai_auth = false`,
          ].join("\n"),
          hint: t("user.useKey.hints.codexConfig"),
        },
        {
          id: "codex-env",
          title: t("user.useKey.captions.terminal"),
          isFile: false,
          content: `${envBlock([["SLIPGATE_API_KEY", key]])}\ncodex`,
          hint: persistHint,
        },
      ];

    case "gemini":
      return [
        {
          id: "gemini-env",
          title: t("user.useKey.captions.terminal"),
          isFile: false,
          content: `${envBlock([
            ["GOOGLE_GEMINI_BASE_URL", base],
            ["GEMINI_API_KEY", key],
          ])}\ngemini`,
          hint: t("user.useKey.hints.geminiEnv"),
        },
        {
          id: "gemini-dotenv",
          title: homePath(".gemini", ".env"),
          isFile: true,
          content: `GOOGLE_GEMINI_BASE_URL=${base}\nGEMINI_API_KEY=${key}`,
          hint: t("user.useKey.hints.geminiDotenv"),
        },
      ];

    case "sdk":
      return [
        {
          id: "sdk-env",
          title: t("user.useKey.captions.env"),
          isFile: false,
          content: envBlock([
            ["OPENAI_BASE_URL", `${base}/v1`],
            ["OPENAI_API_KEY", key],
          ]),
          hint: t("user.useKey.hints.sdkEnv"),
        },
        {
          id: "sdk-python",
          title: "Python · pip install openai",
          isFile: false,
          content: [
            "from openai import OpenAI",
            "",
            "client = OpenAI(",
            `    base_url="${base}/v1",`,
            `    api_key="${key}",`,
            ")",
            "",
            "resp = client.chat.completions.create(",
            `    model="${mdl}",`,
            '    messages=[{"role": "user", "content": "Hello!"}],',
            ")",
            "print(resp.choices[0].message.content)",
          ].join("\n"),
        },
        {
          id: "sdk-node",
          title: "Node.js · npm install openai",
          isFile: false,
          content: [
            'import OpenAI from "openai";',
            "",
            "const client = new OpenAI({",
            `  baseURL: "${base}/v1",`,
            `  apiKey: "${key}",`,
            "});",
            "",
            "const resp = await client.chat.completions.create({",
            `  model: "${mdl}",`,
            '  messages: [{ role: "user", content: "Hello!" }],',
            "});",
            "console.log(resp.choices[0].message.content);",
          ].join("\n"),
        },
      ];

    default: {
      const isTypeSafe = props.group?.platform === "typesafe" || mdl.startsWith("jev-");
      const url = isTypeSafe ? `${base}/v1/systemone` : `${base}/v1/chat/completions`;
      let content: string;
      if (isTypeSafe) {
        if (os.value === "powershell") {
          content = [
            `$headers = @{ Authorization = "Bearer ${key}" }`,
            `$body = @{ model = "${mdl}"; state = "Hello!"; questions = @{ check = @{ type = "noul"; instructions = "Is this valid?" } } } | ConvertTo-Json -Depth 6`,
            `Invoke-RestMethod -Uri "${url}" -Method Post -Headers $headers -ContentType "application/json" -Body $body`,
          ].join("\n");
        } else if (os.value === "cmd") {
          content = [
            `curl ${url} ^`,
            `  -H "Authorization: Bearer ${key}" ^`,
            `  -H "Content-Type: application/json" ^`,
            `  -d "{\\"model\\":\\"${mdl}\\",\\"state\\":\\"Hello!\\",\\"questions\\":{\\"check\\":{\\"type\\":\\"noul\\",\\"instructions\\":\\"Is this valid?\\"}}}"`,
          ].join("\n");
        } else {
          content = [
            `curl ${url} \\`,
            `  -H "Authorization: Bearer ${key}" \\`,
            `  -H "Content-Type: application/json" \\`,
            `  -d '{"model":"${mdl}","state":"Hello!","questions":{"check":{"type":"noul","instructions":"Is this valid?"}}}'`,
          ].join("\n");
        }
      } else if (os.value === "powershell") {
        content = [
          `$headers = @{ Authorization = "Bearer ${key}" }`,
          `$body = @{ model = "${mdl}"; messages = @(@{ role = "user"; content = "Hello!" }) } | ConvertTo-Json -Depth 5`,
          `Invoke-RestMethod -Uri "${url}" -Method Post -Headers $headers -ContentType "application/json" -Body $body`,
        ].join("\n");
      } else if (os.value === "cmd") {
        content = [
          `curl ${url} ^`,
          `  -H "Authorization: Bearer ${key}" ^`,
          `  -H "Content-Type: application/json" ^`,
          `  -d "{\\"model\\":\\"${mdl}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hello!\\"}]}"`,
        ].join("\n");
      } else {
        content = [
          `curl ${url} \\`,
          `  -H "Authorization: Bearer ${key}" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '{"model":"${mdl}","messages":[{"role":"user","content":"Hello!"}]}'`,
        ].join("\n");
      }
      return [{ id: "curl", title: t("user.useKey.captions.request"), isFile: false, content, hint: t("user.useKey.hints.curl") }];
    }
  }
});

/** Splits a snippet so the key placeholder can be highlighted. */
function segments(content: string): { text: string; key: boolean }[] {
  if (props.plaintext) return [{ text: content, key: false }];
  const parts = content.split(PLACEHOLDER);
  return parts.flatMap((text, i) => (i < parts.length - 1 ? [{ text, key: false }, { text: PLACEHOLDER, key: true }] : [{ text, key: false }]));
}

const docUrl = computed(() => portal.settings?.docUrl || "");
</script>

<template>
  <UiModal
    :open="open"
    width="lg"
    :title="apiKey ? t('user.useKey.title', { name: apiKey.name }) : t('user.useKey.action')"
    @update:open="emit('update:open', $event)"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon name="terminal" :size="15" />
      </span>
    </template>

    <div v-if="apiKey" class="space-y-4">
      <!-- Endpoint + key summary -->
      <div class="grid gap-2 rounded-xl border border-line bg-surface-2/40 p-3 text-xs sm:grid-cols-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 text-fg-subtle">{{ t("user.useKey.baseUrl") }}</span>
          <code class="min-w-0 flex-1 truncate font-mono text-fg" :title="baseUrl">{{ baseUrl }}</code>
          <CopyButton :text="baseUrl" />
        </div>
        <div class="flex min-w-0 items-center gap-2 sm:justify-end">
          <span class="shrink-0 text-fg-subtle">{{ t("user.useKey.key") }}</span>
          <span class="code-chip truncate">{{ apiKey.keyPrefix }}</span>
          <UiBadge class="shrink-0">{{ apiKey.groupName }}</UiBadge>
        </div>
      </div>

      <UiAlert v-if="plaintext" tone="success">{{ t("user.useKey.notice.plain") }}</UiAlert>
      <UiAlert v-else tone="warning">
        {{ t("user.useKey.notice.placeholder") }}
        <code class="ml-1 rounded bg-warning/15 px-1 font-mono text-2xs text-warning">{{ PLACEHOLDER }}</code>
      </UiAlert>

      <UiTabs v-model="client" :tabs="clientTabs" />

      <div class="flex flex-wrap items-end justify-between gap-3">
        <SegmentedControl v-model="os" :options="osOptions" />
        <label v-if="showsModel" class="flex min-w-0 items-center gap-2 text-xs">
          <span class="shrink-0 text-fg-subtle">{{ t("user.useKey.model") }}</span>
          <input
            v-model="model"
            type="text"
            spellcheck="false"
            list="use-key-models"
            class="input input-sm w-48 max-w-full font-mono"
            :placeholder="defaultModel(group)"
          />
          <datalist v-if="modelOptions.length" id="use-key-models">
            <option v-for="m in modelOptions" :key="m" :value="m" />
          </datalist>
        </label>
      </div>

      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <div :key="`${client}-${os}`" class="space-y-3">
          <section
            v-for="(snip, i) in snippets"
            :key="snip.id"
            class="animate-slide-up overflow-hidden rounded-xl border border-line motion-reduce:animate-none"
            :style="{ animationDelay: `${i * 60}ms`, animationFillMode: 'both' }"
          >
            <header class="flex items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5">
              <p class="flex min-w-0 items-center gap-2 text-xs">
                <UiIcon :name="snip.isFile ? 'file' : 'terminal'" :size="13" class="shrink-0 text-fg-subtle" />
                <span class="truncate font-medium" :class="snip.isFile ? 'font-mono text-fg' : 'text-fg-muted'">{{ snip.title }}</span>
              </p>
              <CopyButton :text="snip.content" :label="t('common.copy')" />
            </header>
            <pre
              class="max-h-72 overflow-auto bg-surface-2/25 px-3.5 py-3 font-mono text-xs leading-relaxed text-fg"
            ><code><template v-for="(seg, j) in segments(snip.content)" :key="j"><mark
              v-if="seg.key"
              class="rounded bg-warning/15 px-0.5 text-warning"
            >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></pre>
            <p v-if="snip.hint" class="flex items-start gap-1.5 border-t border-line/70 px-3 py-2 text-2xs leading-relaxed text-fg-subtle">
              <UiIcon name="info" :size="11" class="mt-0.5 shrink-0" />
              <span>{{ snip.hint }}</span>
            </p>
          </section>
        </div>
      </Transition>
    </div>

    <template #footer>
      <a
        v-if="docUrl"
        :href="docUrl"
        target="_blank"
        rel="noopener"
        class="btn btn-ghost mr-auto"
      >
        <UiIcon name="book-open" :size="15" />
        {{ t("user.useKey.docs") }}
        <UiIcon name="external-link" :size="12" />
      </a>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.close") }}</button>
    </template>
  </UiModal>
</template>
