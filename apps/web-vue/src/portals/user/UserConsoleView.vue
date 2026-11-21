<script setup lang="ts">
import { computed, ref } from "vue";
import { formatNanoUsd, NANO_PER_USD } from "@slipgate/contracts";

const balanceNano = ref<bigint>(25n * NANO_PER_USD + 500_000_000n);
const heldNano = ref<bigint>(1_250_000_000n);

const formattedBalance = computed(() => formatNanoUsd(balanceNano.value));
const formattedAvailable = computed(() => formatNanoUsd(balanceNano.value - heldNano.value));
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">用户配额账本（nano-USD 定点精度）</h2>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <p class="text-xs text-slate-400">总余额</p>
          <p class="mt-1 font-mono text-2xl font-bold text-white">{{ formattedBalance }}</p>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <p class="text-xs text-slate-400">当前可用（扣除流式预冻结）</p>
          <p class="mt-1 font-mono text-2xl font-bold text-sky-400">{{ formattedAvailable }}</p>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">统一网关接入端点（直走 DataPlane，不经过 BFF）</h2>
      <ul class="mt-3 space-y-2 font-mono text-sm text-slate-300">
        <li>POST /v1/chat/completions · OpenAI Chat Completions</li>
        <li>POST /v1/responses · OpenAI Stateful Responses / WebSocket</li>
        <li>POST /v1/messages · Anthropic Messages</li>
        <li>POST /v1beta/models/:model:generateContent · Google Gemini</li>
        <li>POST /mcp/ · Model Context Protocol</li>
      </ul>
    </section>
  </div>
</template>
