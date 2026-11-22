import { ref, watch, type Ref } from "vue";

/**
 * A ref mirrored into localStorage. Reads are validated (stale or foreign values fall back
 * to the default) and every access is guarded: private mode or blocked storage only loses
 * persistence, never the page.
 */
export function usePersistentState<T>(key: string, fallback: T, validate: (value: unknown) => value is T): Ref<T> {
  let initial = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (validate(parsed)) initial = parsed;
    }
  } catch {
    // Unavailable or corrupt storage: keep the default.
  }
  const state = ref(initial) as Ref<T>;
  watch(
    state,
    (value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Quota or privacy mode: the preference just won't survive a reload.
      }
    },
    { deep: true },
  );
  return state;
}
