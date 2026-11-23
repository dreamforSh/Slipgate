import type { Directive } from "vue";

/**
 * `v-reveal` / `v-reveal="120"`: fades an element up the first time it scrolls into view, with
 * an optional delay in ms for staggering siblings. Everything is inline style, so the effect
 * needs no global CSS, and the styles are removed once the reveal finishes so hover
 * transforms on cards keep working. Skipped entirely under prefers-reduced-motion.
 */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const DURATION_MS = 700;

let observer: IntersectionObserver | null = null;
const delays = new WeakMap<Element, number>();
const cleanups = new WeakMap<Element, number>();

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function reveal(el: HTMLElement) {
  el.style.opacity = "1";
  el.style.transform = "translateY(0)";
  const delay = delays.get(el) ?? 0;
  cleanups.set(
    el,
    window.setTimeout(() => {
      el.style.removeProperty("opacity");
      el.style.removeProperty("transform");
      el.style.removeProperty("transition");
      el.style.removeProperty("will-change");
    }, delay + DURATION_MS + 50),
  );
}

function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        reveal(entry.target as HTMLElement);
      }
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
  );
  return observer;
}

export const vReveal: Directive<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;
    const delay = Math.max(0, binding.value ?? 0);
    delays.set(el, delay);
    el.style.opacity = "0";
    el.style.transform = "translateY(18px)";
    el.style.transition = `opacity ${DURATION_MS - 100}ms ${EASE} ${delay}ms, transform ${DURATION_MS}ms ${EASE} ${delay}ms`;
    el.style.willChange = "opacity, transform";
    sharedObserver().observe(el);
  },
  beforeUnmount(el) {
    observer?.unobserve(el);
    const timer = cleanups.get(el);
    if (timer !== undefined) window.clearTimeout(timer);
  },
};
