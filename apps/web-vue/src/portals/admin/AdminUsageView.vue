<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { GroupItem } from "@slipgate/contracts";
import UsageLogsPage from "../../components/usage/UsageLogsPage.vue";
import { useToastStore } from "../../stores/toast";
import { apiJson, errorText } from "../../lib/api";

const { t } = useI18n();
const route = useRoute();
const toast = useToastStore();

const groups = ref<{ id: string; name: string }[]>([]);

/** `?userId=` from the user list's "view usage" link. */
const userId = computed(() => (typeof route.query.userId === "string" ? route.query.userId : undefined));

onMounted(async () => {
  try {
    const res = await apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups");
    groups.value = res.groups
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((g) => ({ id: g.id, name: g.name }));
  } catch (err) {
    toast.error(errorText(err, t("usageLogs.errors.groups")));
  }
});
</script>

<template>
  <UsageLogsPage mode="admin" :title="t('nav.adminUsage')" :groups="groups" :user-id="userId" />
</template>
