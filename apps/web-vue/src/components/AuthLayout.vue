<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import BrandMark from "./BrandMark.vue";
import LocaleSwitcher from "./LocaleSwitcher.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

defineProps<{ siteName?: string }>();

const { t } = useI18n();

const features = computed<{ icon: IconName; label: string }[]>(() => [
  { icon: "zap", label: t("auth.features.unified") },
  { icon: "shield", label: t("auth.features.isolated") },
  { icon: "wallet", label: t("auth.features.billing") },
]);
</script>

<template>
  <div class="relative flex min-h-screen flex-col overflow-hidden">
    <!-- Backdrop: soft wash, glow orbs and a faded grid -->
    <div class="backdrop absolute inset-0" aria-hidden="true" />
    <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div class="orb absolute -right-40 -top-40 h-96 w-96 rounded-full blur-3xl motion-safe:animate-drift" />
      <div class="orb orb-soft absolute -bottom-48 -left-40 h-96 w-96 rounded-full blur-3xl motion-safe:animate-drift [animation-delay:-11s] [animation-direction:reverse]" />
      <div class="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
    </div>

    <header class="relative z-20 flex items-center justify-end gap-1 px-4 py-4 sm:px-6">
      <LocaleSwitcher />
      <ThemeSwitcher compact />
    </header>

    <main class="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
      <div class="w-full max-w-md">
        <div class="mb-8 flex flex-col items-center text-center">
          <BrandMark :size="56" glow draw class="mb-4 animate-pop-in" />
          <p class="text-gradient animate-fade-up text-3xl font-bold tracking-tight [animation-delay:80ms]">{{ siteName || "Slipgate" }}</p>
        </div>

        <div class="card glass animate-fade-up p-6 shadow-card-hover [animation-delay:140ms] sm:p-8">
          <slot />
        </div>

        <ul class="mt-6 flex flex-wrap items-center justify-center gap-2">
          <li
            v-for="(f, i) in features"
            :key="f.icon"
            class="inline-flex animate-fade-up items-center gap-1.5 rounded-full bg-surface/70 px-3 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line backdrop-blur transition-colors duration-200 hover:text-fg hover:ring-accent/30"
            :style="{ animationDelay: `${260 + i * 70}ms` }"
          >
            <UiIcon :name="f.icon" :size="13" class="text-accent" />
            {{ f.label }}
          </li>
        </ul>
      </div>
    </main>
  </div>
</template>

<style scoped>
.backdrop {
  background: linear-gradient(
    135deg,
    rgb(var(--bg)) 0%,
    rgb(var(--accent-glow) / 0.06) 50%,
    rgb(var(--surface)) 100%
  );
}
.orb {
  background: rgb(var(--accent-glow) / 0.2);
}
.orb-soft {
  background: rgb(var(--accent-glow) / 0.14);
}
</style>
