import { defineStore } from "pinia";
import { computed, nextTick, ref } from "vue";

export type ThemeMode = "system" | "light" | "dark";

/** Viewport point (e.g. the switcher's click position) the theme reveal grows from. */
export interface ThemeOrigin {
  x: number;
  y: number;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => { ready: Promise<void>; finished: Promise<void> };
};

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

  /**
   * Applies the palette with every CSS transition suspended for a frame, so hundreds of
   * `transition-colors` elements flip at once instead of fading out of sync. Where the View
   * Transitions API exists, the new theme is revealed as a circle growing from `origin`.
   */
  function applyAnimated(origin?: ThemeOrigin) {
    const root = document.documentElement;
    const flip = () => {
      root.classList.add("theme-switching");
      apply();
      // Force a style flush so the class swap lands while transitions are off.
      void root.offsetWidth;
      requestAnimationFrame(() => root.classList.remove("theme-switching"));
    };

    const doc = document as ViewTransitionDocument;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || reduced) {
      flip();
      return;
    }
    const x = origin?.x ?? window.innerWidth - 48;
    const y = origin?.y ?? 32;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = doc.startViewTransition(async () => {
      flip();
      await nextTick();
    });
    transition.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 520, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
        );
      })
      .catch(() => {
        // Skipped transitions (tab hidden, another one started) already applied the theme.
      });
  }

  function setMode(next: ThemeMode, origin?: ThemeOrigin) {
    const wasDark = isDark.value;
    mode.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    if (wasDark === isDark.value) apply();
    else applyAnimated(origin);
  }

  function cycle(origin?: ThemeOrigin) {
    const order: ThemeMode[] = ["system", "light", "dark"];
    setMode(order[(order.indexOf(mode.value) + 1) % order.length]!, origin);
  }

  media.addEventListener("change", (ev) => {
    systemDark.value = ev.matches;
    applyAnimated();
  });

  apply();

  return { mode, isDark, setMode, cycle };
});
