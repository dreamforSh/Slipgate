import { watch, type Ref } from "vue";
import { useToastStore } from "../stores/toast";

/** Mirror a view's error / notice refs into global toasts. */
export function useFeedbackToasts(error: Ref<string | null>, notice?: Ref<string | null>) {
  const toast = useToastStore();
  watch(error, (message) => {
    if (message) toast.error(message);
  });
  if (notice) {
    watch(notice, (message) => {
      if (message) toast.success(message);
    });
  }
  return toast;
}
