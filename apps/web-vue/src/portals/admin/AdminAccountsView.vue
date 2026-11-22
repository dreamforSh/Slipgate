<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  allowedSubscriptionTiersForProvider,
  recommendedMaxConcurrencyForTier,
  type AccountAuthKind,
  type ExecutionMode,
  type GroupItem,
  type GroupPlatform,
  type GroupSubscriptionType,
  type Provider,
  type SubscriptionTier,
  type UpstreamAccount,
} from "@slipgate/contracts";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDrawer from "../../components/ui/UiDrawer.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import UsageMeter from "../../components/ui/UsageMeter.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import {
  ACCOUNT_STATUS_LABEL,
  EXECUTION_MODE_LABEL,
  PROVIDER_OPTIONS,
  healthTone,
  type Tone,
} from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

const groups = ref<GroupItem[]>([]);
const accounts = ref<UpstreamAccount[]>([]);
const modeFilter = ref<"all" | ExecutionMode>("all");
const errorMessage = ref<string | null>(null);
const loading = ref(false);
const groupDrawerOpen = ref(false);
const accountDrawerOpen = ref(false);

useFeedbackToasts(errorMessage);

// Group creation form
const groupName = ref("");
const groupPlatform = ref<GroupPlatform>("composite");
const groupSubType = ref<GroupSubscriptionType>("balance");
const groupMultiplier = ref(1);

// Account creation form
const accName = ref("");
const accGroupId = ref("");
const accPlatform = ref<Provider>("anthropic");
const accMode = ref<ExecutionMode>("stealth_http");
const accAuthKind = ref<AccountAuthKind>("oauth");
const accSubscriptionTier = ref<SubscriptionTier>("max");
const accSecret = ref("");
const accMaxConc = ref(12);
const accPriority = ref(100);

const tierOptions = computed(() => allowedSubscriptionTiersForProvider(accPlatform.value));

type SubscriptionPreset =
  | "claude_max"
  | "claude_ultra"
  | "codex_pro_5x"
  | "codex_pro_10x"
  | "codex_pro_25x"
  | "antigravity";

const presets: { key: SubscriptionPreset; label: string; tone: Tone }[] = [
  { key: "claude_max", label: "Claude Max · 5x", tone: "warning" },
  { key: "claude_ultra", label: "Claude Ultra · 20x", tone: "warning" },
  { key: "codex_pro_5x", label: "Codex Pro · 5x", tone: "success" },
  { key: "codex_pro_10x", label: "Codex Pro · 10x", tone: "success" },
  { key: "codex_pro_25x", label: "Codex Pro · 25x", tone: "success" },
  { key: "antigravity", label: "Antigravity VM", tone: "violet" },
];

const presetToneClass: Record<string, string> = {
  warning: "border-warning/30 bg-warning/[0.07] text-warning hover:bg-warning/15",
  success: "border-success/30 bg-success/[0.07] text-success hover:bg-success/15",
  violet: "border-violet/30 bg-violet/[0.07] text-violet hover:bg-violet/15",
};

function onPlatformChange() {
  const valid = tierOptions.value.some((o) => o.tier === accSubscriptionTier.value);
  if (!valid) {
    if (accPlatform.value === "anthropic") {
      accSubscriptionTier.value = "max";
    } else if (accPlatform.value === "codex" || accPlatform.value === "openai") {
      accSubscriptionTier.value = "pro_5x";
    } else if (accPlatform.value === "antigravity") {
      accSubscriptionTier.value = "pro";
    } else {
      accSubscriptionTier.value = "standard";
    }
  }
  accMaxConc.value = recommendedMaxConcurrencyForTier(accPlatform.value, accSubscriptionTier.value);
}

function onTierChange() {
  accMaxConc.value = recommendedMaxConcurrencyForTier(accPlatform.value, accSubscriptionTier.value);
}

function applySubscriptionTemplate(preset: SubscriptionPreset) {
  if (preset === "claude_max" || preset === "claude_ultra") {
    accPlatform.value = "anthropic";
    accMode.value = "stealth_http";
    accAuthKind.value = "oauth";
    accSubscriptionTier.value = preset === "claude_ultra" ? "ultra" : "max";
    accMaxConc.value = recommendedMaxConcurrencyForTier("anthropic", accSubscriptionTier.value);
    if (!accSecret.value.trim()) {
      accSecret.value = JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-replace-me",
          refreshToken: "sk-ant-ort01-replace-me",
          subscriptionType: accSubscriptionTier.value,
        },
      });
    }
    return;
  }
  if (preset === "codex_pro_5x" || preset === "codex_pro_10x" || preset === "codex_pro_25x") {
    const tier: SubscriptionTier =
      preset === "codex_pro_25x" ? "pro_25x" : preset === "codex_pro_10x" ? "pro_10x" : "pro_5x";
    accPlatform.value = "codex";
    accMode.value = "stealth_http";
    accAuthKind.value = "oauth";
    accSubscriptionTier.value = tier;
    accMaxConc.value = recommendedMaxConcurrencyForTier("codex", tier);
    if (!accSecret.value.trim()) {
      accSecret.value = JSON.stringify({
        tokens: {
          access_token: "eyJhbGciOi-replace-me",
          refresh_token: "rt_replace_me",
          account_id: "acct_chatgpt_replace_me",
          plan_type: tier,
        },
      });
    }
    return;
  }
  accPlatform.value = "antigravity";
  accMode.value = "vm_slot";
  accAuthKind.value = "vm_cli_seed";
  accSubscriptionTier.value = "pro";
  accMaxConc.value = recommendedMaxConcurrencyForTier("antigravity", "pro");
  if (!accSecret.value.trim()) {
    accSecret.value = JSON.stringify({
      accessToken: "ya29.replace-me",
      refreshToken: "1//replace-me",
      projectId: "rising-fact-p41fc",
    });
  }
}

function formatTierBadge(acc: UpstreamAccount): string {
  switch (acc.subscriptionTier) {
    case "ultra":
      return `ULTRA · ${acc.tierMultiplier}x`;
    case "max":
      return `MAX · ${acc.tierMultiplier}x`;
    case "pro_25x":
      return "PRO 25x";
    case "pro_10x":
      return "PRO 10x";
    case "pro_5x":
      return "PRO 5x";
    case "plus":
      return `PLUS · ${acc.tierMultiplier}x`;
    case "pro":
      return `PRO · ${acc.tierMultiplier}x`;
    default:
      return `STD · ${acc.tierMultiplier}x`;
  }
}

function tierTone(acc: UpstreamAccount): Tone {
  if (acc.tierMultiplier >= 20) return "violet";
  if (acc.tierMultiplier >= 5) return "success";
  return "neutral";
}

const filteredAccounts = computed(() => {
  if (modeFilter.value === "all") return accounts.value;
  return accounts.value.filter((a) => a.executionMode === modeFilter.value);
});

const modeOptions = computed(() => {
  const count = (m: ExecutionMode) => accounts.value.filter((a) => a.executionMode === m).length;
  return [
    { value: "all" as const, label: "全部", count: accounts.value.length },
    { value: "stealth_http" as const, label: "stealth_http", count: count("stealth_http") },
    { value: "vm_slot" as const, label: "vm_slot", count: count("vm_slot") },
    { value: "direct_api" as const, label: "direct_api", count: count("direct_api") },
  ];
});

const activeAccounts = computed(() => accounts.value.filter((a) => a.status === "active").length);
const enabledGroups = computed(() => groups.value.filter((g) => g.enabled).length);
const totalWeight = computed(() => accounts.value.reduce((s, a) => s + (a.status === "active" ? a.tierMultiplier : 0), 0));
const totalConcurrency = computed(() =>
  accounts.value.reduce((s, a) => s + (a.status === "active" ? a.maxConcurrency : 0), 0),
);

async function refreshPool() {
  errorMessage.value = null;
  loading.value = true;
  try {
    const [gRes, aRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/groups"),
      auth.apiFetch("/api/v1/admin/accounts"),
    ]);
    if (gRes.ok) {
      const data = (await gRes.json()) as { groups: GroupItem[] };
      groups.value = data.groups;
      if (!accGroupId.value && groups.value.length > 0) {
        accGroupId.value = groups.value[0]!.id;
      }
    }
    if (aRes.ok) {
      const data = (await aRes.json()) as { accounts: UpstreamAccount[] };
      accounts.value = data.accounts;
    }
  } finally {
    loading.value = false;
  }
}

async function handleCreateGroup() {
  errorMessage.value = null;
  const res = await auth.apiFetch("/api/v1/admin/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: groupName.value,
      platform: groupPlatform.value,
      subscriptionType: groupSubType.value,
      rateMultiplier: groupMultiplier.value,
    }),
  });
  const data = (await res.json()) as { message?: string };
  if (!res.ok) {
    errorMessage.value = data.message ?? "创建分组失败";
    return;
  }
  groupName.value = "";
  groupDrawerOpen.value = false;
  await refreshPool();
}

async function toggleGroup(group: GroupItem) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/groups/${group.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !group.enabled }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "更新分组失败";
    return;
  }
  await refreshPool();
}

async function removeGroup(groupId: string) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/groups/${groupId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "删除分组失败";
    return;
  }
  await refreshPool();
}

async function handleCreateAccount() {
  errorMessage.value = null;
  const res = await auth.apiFetch("/api/v1/admin/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: accName.value,
      groupId: accGroupId.value,
      platform: accPlatform.value,
      executionMode: accMode.value,
      authKind: accAuthKind.value,
      subscriptionTier: accSubscriptionTier.value,
      credentialSecret: accSecret.value,
      maxConcurrency: accMaxConc.value,
      priority: accPriority.value,
    }),
  });
  const data = (await res.json()) as { message?: string };
  if (!res.ok) {
    errorMessage.value = data.message ?? "添加账号失败";
    return;
  }
  accName.value = "";
  accSecret.value = "";
  accountDrawerOpen.value = false;
  await refreshPool();
}

async function changeAccountTier(acc: UpstreamAccount, nextTier: SubscriptionTier) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${acc.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscriptionTier: nextTier,
      maxConcurrency: recommendedMaxConcurrencyForTier(acc.platform, nextTier),
    }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "更新订阅档位失败";
    return;
  }
  await refreshPool();
}

async function toggleAccountStatus(acc: UpstreamAccount) {
  errorMessage.value = null;
  const nextStatus = acc.status === "active" ? "paused" : "active";
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${acc.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: nextStatus }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "更新账号状态失败";
    return;
  }
  await refreshPool();
}

async function removeAccount(accountId: string) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${accountId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "删除账号失败";
    return;
  }
  await refreshPool();
}

onMounted(() => {
  void refreshPool();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="号池与分组" description="管理路由分组与上游账号；凭据以 AES-256-GCM 密文入库，按档位权重参与调度。">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshPool">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          刷新
        </button>
        <button type="button" class="btn btn-secondary" @click="groupDrawerOpen = true">
          <UiIcon name="layers" :size="15" />
          新增分组
        </button>
        <button type="button" class="btn btn-primary" @click="accountDrawerOpen = true">
          <UiIcon name="plus" :size="15" />
          添加账号
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="活跃账号" :value="`${activeAccounts} / ${accounts.length}`" icon="users" tone="success" />
      <StatCard label="启用分组" :value="`${enabledGroups} / ${groups.length}`" icon="layers" tone="accent" />
      <StatCard label="调度总权重" :value="`${totalWeight}x`" icon="gauge" tone="violet" hint="活跃账号档位倍率之和" />
      <StatCard label="可用并发" :value="totalConcurrency" icon="zap" tone="info" hint="活跃账号并发上限之和" />
    </div>

    <!-- Groups -->
    <UiCard icon="layers" title="路由分组" description="API Key 绑定分组，分组决定上游平台与计费倍率">
      <EmptyState v-if="groups.length === 0" compact icon="layers" title="暂无分组">
        <button type="button" class="btn btn-primary btn-sm" @click="groupDrawerOpen = true">
          <UiIcon name="plus" :size="14" />
          新增分组
        </button>
      </EmptyState>
      <div v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="g in groups"
          :key="g.id"
          class="flex flex-col rounded-lg border border-line bg-surface-2/30 p-4 transition-colors hover:border-line-strong"
          :class="g.enabled ? '' : 'opacity-70'"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-fg">{{ g.name }}</p>
              <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ g.id }}</p>
            </div>
            <UiSwitch :model-value="g.enabled" :label="g.enabled ? '已启用' : '已禁用'" @update:model-value="toggleGroup(g)" />
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-1.5">
            <UiBadge tone="accent" mono>{{ g.platform }}</UiBadge>
            <UiBadge>{{ g.subscriptionType === "subscription" ? "订阅套餐" : "按量扣费" }}</UiBadge>
          </div>
          <div class="mt-3 flex items-end justify-between border-t border-line/70 pt-3">
            <dl class="flex gap-5">
              <div>
                <dt class="text-2xs text-fg-subtle">倍率</dt>
                <dd class="font-mono text-sm font-medium text-fg">{{ g.rateMultiplier }}x</dd>
              </div>
              <div>
                <dt class="text-2xs text-fg-subtle">账号</dt>
                <dd class="font-mono text-sm font-medium text-fg">{{ g.accountCount }}</dd>
              </div>
            </dl>
            <ConfirmButton icon-only @confirm="removeGroup(g.id)" />
          </div>
        </div>
      </div>
    </UiCard>

    <!-- Accounts -->
    <UiCard icon="users" title="上游号池" description="按优先级与档位权重加权调度，5h / 7d 窗口达到 95% 水位提前冷却" flush>
      <template #actions>
        <SegmentedControl v-model="modeFilter" :options="modeOptions" />
      </template>
      <EmptyState
        v-if="filteredAccounts.length === 0"
        icon="users"
        :title="accounts.length === 0 ? '号池为空' : '没有符合筛选条件的账号'"
        :description="accounts.length === 0 ? '添加第一个上游账号，网关即可开始调度请求。' : undefined"
      >
        <button v-if="accounts.length === 0" type="button" class="btn btn-primary btn-sm" @click="accountDrawerOpen = true">
          <UiIcon name="plus" :size="14" />
          添加账号
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>平台 / 档位</th>
              <th>执行 / 认证</th>
              <th>窗口用量</th>
              <th class="text-right">并发 / 优先级</th>
              <th>状态</th>
              <th class="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="acc in filteredAccounts" :key="acc.id">
              <td class="max-w-[16rem]">
                <p class="truncate font-medium text-fg">{{ acc.name }}</p>
                <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle" :title="acc.credentialPreview">
                  {{ acc.groupName }} · {{ acc.credentialPreview }}
                </p>
              </td>
              <td>
                <div class="flex flex-col items-start gap-1">
                  <UiBadge tone="accent" mono>{{ acc.platform }}</UiBadge>
                  <UiBadge :tone="tierTone(acc)" mono>{{ formatTierBadge(acc) }}</UiBadge>
                </div>
              </td>
              <td>
                <p class="text-xs text-fg">{{ EXECUTION_MODE_LABEL[acc.executionMode] ?? acc.executionMode }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ acc.authKind }}</p>
              </td>
              <td>
                <div class="flex w-40 flex-col gap-1.5">
                  <UsageMeter label="5h" :bps="acc.window5hUsedBps" />
                  <UsageMeter label="7d" :bps="acc.window7dUsedBps" />
                </div>
              </td>
              <td class="text-right font-mono text-xs tabular-nums">
                <p class="text-fg">{{ acc.maxConcurrency }}</p>
                <p class="mt-0.5 text-fg-subtle">#{{ acc.priority }}</p>
              </td>
              <td>
                <div class="flex flex-col items-start gap-1.5">
                  <UiSwitch
                    v-if="acc.status === 'active' || acc.status === 'paused'"
                    :model-value="acc.status === 'active'"
                    :label="ACCOUNT_STATUS_LABEL[acc.status]"
                    @update:model-value="toggleAccountStatus(acc)"
                  />
                  <button
                    v-else
                    type="button"
                    class="cursor-pointer"
                    title="点击恢复为活跃"
                    @click="toggleAccountStatus(acc)"
                  >
                    <UiBadge :tone="healthTone(acc.status)" dot>{{ ACCOUNT_STATUS_LABEL[acc.status] ?? acc.status }}</UiBadge>
                  </button>
                </div>
              </td>
              <td class="text-right">
                <div class="inline-flex items-center gap-1">
                  <select
                    :value="acc.subscriptionTier"
                    class="select input-sm w-36 font-mono"
                    aria-label="订阅档位"
                    @change="changeAccountTier(acc, ($event.target as HTMLSelectElement).value as SubscriptionTier)"
                  >
                    <option
                      v-for="opt in allowedSubscriptionTiersForProvider(acc.platform)"
                      :key="opt.tier"
                      :value="opt.tier"
                    >
                      {{ opt.label }}
                    </option>
                  </select>
                  <ConfirmButton icon-only @confirm="removeAccount(acc.id)" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Create group drawer -->
    <UiDrawer v-model:open="groupDrawerOpen" title="新增路由分组">
      <form id="create-group-form" class="space-y-4" @submit.prevent="handleCreateGroup">
        <FormField label="分组名称" required>
          <input v-model="groupName" type="text" required placeholder="例如 claude-pro-pool" class="input" />
        </FormField>
        <FormField label="平台" hint="composite 分组可通过合成路由规则把模型分流到多个平台">
          <select v-model="groupPlatform" class="select">
            <option value="composite">composite（合成路由）</option>
            <option value="anthropic">anthropic（Claude）</option>
            <option value="codex">codex（ChatGPT Plus/Pro）</option>
            <option value="antigravity">antigravity（反重力）</option>
            <option value="openai">openai</option>
            <option value="gemini">gemini</option>
            <option value="grok">grok</option>
          </select>
        </FormField>
        <div class="grid grid-cols-2 gap-3">
          <FormField label="计费方式">
            <select v-model="groupSubType" class="select">
              <option value="balance">按量扣费</option>
              <option value="subscription">订阅套餐</option>
            </select>
          </FormField>
          <FormField label="费率倍率">
            <input v-model.number="groupMultiplier" type="number" step="0.1" min="0.01" class="input font-mono" />
          </FormField>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="groupDrawerOpen = false">取消</button>
        <button type="submit" form="create-group-form" class="btn btn-primary">创建分组</button>
      </template>
    </UiDrawer>

    <!-- Create account drawer -->
    <UiDrawer
      v-model:open="accountDrawerOpen"
      title="添加上游账号"
      description="凭据经 AES-256-GCM 加密后入库，列表中只显示脱敏预览"
      width="lg"
    >
      <form id="create-account-form" class="space-y-5" @submit.prevent="handleCreateAccount">
        <div>
          <p class="label flex items-center gap-1.5">
            <UiIcon name="sparkles" :size="13" />
            订阅档位快速预设
          </p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in presets"
              :key="p.key"
              type="button"
              class="inline-flex h-7 cursor-pointer items-center rounded-md border px-2.5 text-xs font-medium transition-colors"
              :class="presetToneClass[p.tone]"
              @click="applySubscriptionTemplate(p.key)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField label="账号别名" required>
            <input v-model="accName" type="text" required placeholder="如 claude-ultra-01" class="input" />
          </FormField>
          <FormField label="所属分组" required>
            <select v-model="accGroupId" required class="select">
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </FormField>
          <FormField label="平台">
            <select v-model="accPlatform" class="select" @change="onPlatformChange">
              <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </FormField>
          <FormField label="订阅档位" hint="切换档位会自动填入推荐并发上限">
            <select v-model="accSubscriptionTier" class="select" @change="onTierChange">
              <option v-for="opt in tierOptions" :key="opt.tier" :value="opt.tier">{{ opt.label }}</option>
            </select>
          </FormField>
          <FormField label="执行模式">
            <select v-model="accMode" class="select">
              <option value="stealth_http">stealth_http（uTLS + Clash）</option>
              <option value="vm_slot">vm_slot（KVM / VM 执行槽）</option>
              <option value="direct_api">direct_api（官方密钥直连）</option>
            </select>
          </FormField>
          <FormField label="认证方式">
            <select v-model="accAuthKind" class="select">
              <option value="oauth">oauth（订阅 OAuth）</option>
              <option value="setup_token">setup_token（sk-ant-oat*）</option>
              <option value="vm_cli_seed">vm_cli_seed（VM 凭据种子）</option>
              <option value="api_key">api_key</option>
            </select>
          </FormField>
          <FormField label="并发上限">
            <input v-model.number="accMaxConc" type="number" min="1" max="64" class="input font-mono" />
          </FormField>
          <FormField label="优先级" hint="数值越小越优先">
            <input v-model.number="accPriority" type="number" min="0" max="10000" class="input font-mono" />
          </FormField>
        </div>

        <FormField label="凭据" required hint="粘贴 .claude/.credentials.json、.codex/auth.json、Antigravity JSON 或 API Key">
          <textarea v-model="accSecret" rows="6" required spellcheck="false" class="textarea font-mono text-xs" />
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="accountDrawerOpen = false">取消</button>
        <button type="submit" form="create-account-form" class="btn btn-primary">
          <UiIcon name="lock" :size="14" />
          加密入库
        </button>
      </template>
    </UiDrawer>
  </div>
</template>
