<script setup lang="ts">
import { useI18n } from "vue-i18n";
import CopyButton from "../../ui/CopyButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import UiIcon from "../../ui/UiIcon.vue";

/** Shown when no plugin is registered: what a plugin is and a minimal one to start from. */
const { t } = useI18n();

const SAMPLE = `import { defineSlipgatePlugin } from "@slipgate/plugin-sdk";

export const teamNotifyPlugin = defineSlipgatePlugin({
  name: "team-notify",
  version: "1.0.0",
  description: "Post settled payments to the team chat.",
  settings: [
    { key: "url", label: "Webhook URL", placeholder: "https://chat.example.com/hook" },
    { key: "token", label: "Access token", secret: true },
  ],
  async onPaymentSettled(ctx, event) {
    const url = ctx.config?.url;
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { Authorization: \`Bearer \${ctx.config?.token ?? ""}\` },
      body: JSON.stringify({ orderId: event.orderId, amountNanoUsd: event.amountNanoUsd }),
    });
  },
});

// services/bff-ts/src/app.ts
registry.register(teamNotifyPlugin);`;
</script>

<template>
  <div class="card">
    <EmptyState icon="plug" :title="t('adminTools.plugins.empty.title')">
      <div class="w-full min-w-0 max-w-2xl space-y-5">
        <p class="mx-auto max-w-xl text-xs leading-relaxed text-fg-muted">{{ t("adminTools.plugins.empty.body") }}</p>
        <div class="overflow-hidden rounded-xl border border-line bg-surface-2/50 text-left">
          <div class="flex items-center justify-between gap-2 border-b border-line/70 py-1 pl-3 pr-1.5">
            <span class="inline-flex items-center gap-1.5 text-2xs font-medium text-fg-subtle">
              <UiIcon name="braces" :size="12" />
              {{ t("adminTools.plugins.empty.sample") }}
            </span>
            <CopyButton :text="SAMPLE" />
          </div>
          <pre class="overflow-x-auto px-4 py-3 font-mono text-2xs leading-relaxed text-fg"><code>{{ SAMPLE }}</code></pre>
        </div>
      </div>
    </EmptyState>
  </div>
</template>
