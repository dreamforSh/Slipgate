import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { RequestErrorItem } from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";

/**
 * Inspecting (detail drawer) and resolving / reopening request errors, shared by the ops error
 * center and the usage page's errors tab. `onUpdated` receives the item the server returned.
 */
export function useRequestErrorActions(onUpdated: (item: RequestErrorItem) => void) {
  const { t } = useI18n();
  const toast = useToastStore();
  const selected = ref<RequestErrorItem | null>(null);
  const drawerOpen = ref(false);
  const togglingId = ref<string | null>(null);

  async function inspect(item: RequestErrorItem) {
    selected.value = item;
    drawerOpen.value = true;
    try {
      const res = await apiJson<{ item: RequestErrorItem }>(`/api/v1/admin/ops/request-errors/${encodeURIComponent(item.id)}`);
      if (selected.value?.id === item.id) selected.value = res.item;
    } catch {
      // Keep the row snapshot if the detail fetch fails.
    }
  }

  async function toggleResolved(item: RequestErrorItem) {
    togglingId.value = item.id;
    try {
      const res = await apiJson<{ item: RequestErrorItem }>(`/api/v1/admin/ops/request-errors/${encodeURIComponent(item.id)}/resolve`, {
        method: "POST",
        body: { resolved: !item.resolved },
      });
      if (selected.value?.id === item.id) selected.value = res.item;
      onUpdated(res.item);
      toast.success(t("security.ops.requestErrors.table.resolvedToast"));
    } catch (err) {
      toast.error(errorText(err, t("security.ops.errors.load")));
    } finally {
      togglingId.value = null;
    }
  }

  return { selected, drawerOpen, togglingId, inspect, toggleResolved };
}
