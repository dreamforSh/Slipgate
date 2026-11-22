<script setup lang="ts">
import BrandMark from "./BrandMark.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

defineProps<{ siteName?: string }>();

const features: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "zap",
    title: "双平面热路径",
    body: "/v1 数据面只经 Go 边缘与 Zig 核心，管理流量走独立控制面。",
  },
  {
    icon: "shield",
    title: "Fail-Closed 出口",
    body: "节点失效或出口漂移立即熔断，不会退化到宿主机直连。",
  },
  {
    icon: "wallet",
    title: "nano-USD 账本",
    body: "i128 定点复式记账，流式请求预冻结、按 Token 精确结算。",
  },
];
</script>

<template>
  <div class="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
    <!-- Brand panel -->
    <aside class="relative hidden overflow-hidden border-r border-line bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
      <div
        class="pointer-events-none absolute inset-0 opacity-[0.55] [background-image:linear-gradient(rgb(var(--border))_1px,transparent_1px),linear-gradient(90deg,rgb(var(--border))_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_at_top_left,black_20%,transparent_70%)]"
        aria-hidden="true"
      />
      <div class="relative flex items-center gap-3">
        <BrandMark :size="36" />
        <div class="leading-tight">
          <p class="text-base font-semibold text-fg">{{ siteName || "Slipgate" }}</p>
          <p class="text-xs text-fg-subtle">AI API 统一网关控制台</p>
        </div>
      </div>

      <div class="relative max-w-md">
        <h2 class="text-3xl font-semibold leading-tight tracking-tight text-fg">
          一个入口，<br />调度所有上游模型。
        </h2>
        <p class="mt-3 text-sm leading-relaxed text-fg-muted">
          多平台配额调度、独立出口池与 VM 执行槽，统一在一个控制台里管理。
        </p>
        <ul class="mt-8 space-y-5">
          <li v-for="f in features" :key="f.title" class="flex gap-3.5">
            <span
              class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/20"
            >
              <UiIcon :name="f.icon" :size="17" />
            </span>
            <div>
              <p class="text-sm font-medium text-fg">{{ f.title }}</p>
              <p class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ f.body }}</p>
            </div>
          </li>
        </ul>
      </div>

      <p class="relative font-mono text-2xs text-fg-subtle">Go Net · Zig Core · Bun BFF · Vue 3</p>
    </aside>

    <!-- Form panel -->
    <main class="relative flex flex-col px-5 py-6 sm:px-10">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5 lg:invisible">
          <BrandMark :size="28" />
          <span class="text-sm font-semibold text-fg">{{ siteName || "Slipgate" }}</span>
        </div>
        <ThemeSwitcher compact />
      </div>
      <div class="flex flex-1 items-center justify-center py-10">
        <div class="w-full max-w-sm animate-slide-up">
          <slot />
        </div>
      </div>
    </main>
  </div>
</template>
