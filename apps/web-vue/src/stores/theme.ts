import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "slipgate_theme";

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Storage may be unavailable (private mode); fall back to system.
  }
  return "system";
}

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>(readStoredMode());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const systemDark = ref(media.matches);

  const isDark = computed(() => mode.value === "dark" || (mode.value === "system" && systemDark.value));

  function apply() {
    document.documentElement.classList.toggle("dark", isDark.value);
  }

  function setMode(next: ThemeMode) {
    mode.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    apply();
  }

  function cycle() {
    const order: ThemeMode[] = ["system", "light", "dark"];
    setMode(order[(order.indexOf(mode.value) + 1) % order.length]!);
  }

  media.addEventListener("change", (ev) => {
    systemDark.value = ev.matches;
    apply();
  });

  apply();

  return { mode, isDark, setMode, cycle };
});
