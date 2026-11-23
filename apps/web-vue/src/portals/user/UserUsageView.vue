<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem } from "@slipgate/contracts";
import UsageLogsPage from "../../components/usage/UsageLogsPage.vue";
import { useToastStore } from "../../stores/toast";
import { apiJson, errorText } from "../../lib/api";

const { t } = useI18n();
const toast = useToastStore();

const keys = ref<ApiKeyItem[]>([]);

const apiKeys = computed(() => keys.value.map((k) => ({ id: k.id, name: k.name, groupName: k.groupName })));

/** Users only see the groups their own keys are bound to. */
const groups = computed(() => {
  const seen = new Map<string, string>();
  for (const k of keys.value) if (!seen.has(k.groupId)) seen.set(k.groupId, k.groupName || k.groupId);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
});

onMounted(async () => {
  try {
    const res = await apiJson<{ items: ApiKeyItem[] }>("/api/v1/user/api-keys");
    keys.value = res.items;
  } catch (err) {
    toast.error(errorText(err, t("usageLogs.errors.keys")));
  }
});
</script>

<template>
  <UsageLogsPage mode="user" :title="t('nav.myUsage')" :groups="groups" :api-keys="apiKeys" />
</template>
