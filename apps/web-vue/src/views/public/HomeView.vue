<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import PublicLayout from "../../components/PublicLayout.vue";
import TerminalDemo from "../../components/public/TerminalDemo.vue";
import { vReveal } from "../../components/public/reveal";
import CopyButton from "../../components/ui/CopyButton.vue";
import MarkdownView from "../../components/ui/MarkdownView.vue";
import PlatformIcon from "../../components/ui/PlatformIcon.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import { publicJson } from "../../lib/api";
import { platformShortLabel } from "../../lib/platformStyle";
import { useAuthStore } from "../../stores/auth";
import { usePortalStore } from "../../stores/portal";

const { t } = useI18n();
const portal = usePortalStore();
const auth = useAuthStore();

const settings = computed(() => portal.settings);
const subtitle = computed(() => portal.subtitle || t("public.home.tagline"));
const baseUrl = computed(() => (settings.value?.apiBaseUrl || window.location.origin).replace(/\/+$/, ""));

/* ---------------- Admin-authored landing content ---------------- */
const homeContent = ref("");
onMounted(async () => {
  try {
    const res = await publicJson<{ homeContent?: string | null }>("/api/v1/public/home");
    homeContent.value = (res.homeContent ?? "").trim();
  } catch {
    homeContent.value = "";
  }
});

/* ---------------- Calls to action ---------------- */
interface Cta {
  to: string;
  label: string;
  icon: IconName;
}

const primaryCta = computed<Cta>(() => {
  if (auth.isAuthenticated) return { to: auth.isAdmin ? "/admin" : "/dashboard", label: t("public.home.ctaConsole"), icon: "dashboard" };
  if (settings.value?.allowRegistration !== false) return { to: "/login?mode=register", label: t("public.home.ctaRegister"), icon: "arrow-right" };
  return { to: "/login", label: t("public.home.ctaLogin"), icon: "log-in" };
});

const secondaryCta = computed<Cta | null>(() => {
  if (settings.value?.modelPlazaEnabled !== false) return { to: "/models", label: t("public.home.ctaModels"), icon: "store" };
  if (settings.value?.statusPageEnabled !== false) return { to: "/status", label: t("public.home.ctaStatus"), icon: "activity" };
  return null;
});

const highlights = computed<{ icon: IconName; label: string }[]>(() => [
  { icon: "plug", label: t("public.home.highlights.sdk") },
  { icon: "route", label: t("public.home.highlights.failover") },
  { icon: "shield", label: t("public.home.highlights.isolation") },
  { icon: "gauge", label: t("public.home.highlights.metering") },
]);

/* ---------------- Provider strip ---------------- */
const providers = ["anthropic", "openai", "codex", "gemini", "antigravity", "grok", "deepseek", "glm", "kimi", "minimax", "qwen"];

/* ---------------- Feature visuals ---------------- */
const endpoints = [
  { platform: "anthropic", path: "/v1/messages", sdk: "Anthropic SDK" },
  { platform: "openai", path: "/v1/chat/completions", sdk: "OpenAI SDK" },
  { platform: "codex", path: "/v1/responses", sdk: "Codex CLI" },
  { platform: "gemini", path: "/v1beta/models/*:generateContent", sdk: "Gemini SDK" },
];

const egress = [
  { id: "A", ip: "203.0.113.24", slot: "VM-01" },
  { id: "B", ip: "198.51.100.7", slot: "VM-02" },
  { id: "C", ip: "192.0.2.181", slot: "VM-03" },
];

const meterRows = computed(() => [
  { label: t("public.home.features.metering.input"), tokens: "1,284", cost: "$0.003852000" },
  { label: t("public.home.features.metering.output"), tokens: "356", cost: "$0.005340000" },
  { label: t("public.home.features.metering.cache"), tokens: "8,192", cost: "$0.002457600" },
]);

const schedule = computed(() => [
  { id: "A", icon: "x-circle" as IconName, cls: "text-danger", badge: `429 · ${t("public.home.features.scheduling.cooldown")}`, badgeCls: "bg-danger/10 text-danger ring-danger/20" },
  { id: "B", icon: "check-circle" as IconName, cls: "text-success", badge: `200 · ${t("public.home.features.scheduling.takeover")}`, badgeCls: "bg-success/10 text-success ring-success/20" },
  { id: "C", icon: "clock" as IconName, cls: "text-fg-subtle", badge: t("public.home.features.scheduling.standby"), badgeCls: "bg-surface-2 text-fg-muted ring-fg-subtle/20" },
]);

/* ---------------- Quick start snippet ---------------- */
const snippetLines = computed(() => [
  "# Claude Code / Anthropic SDK",
  `export ANTHROPIC_BASE_URL="${baseUrl.value}"`,
  'export ANTHROPIC_API_KEY="sk-sg-…"',
  "",
  "# OpenAI SDK / Codex CLI",
  `export OPENAI_BASE_URL="${baseUrl.value}/v1"`,
  'export OPENAI_API_KEY="sk-sg-…"',
]);
const snippetText = computed(() => snippetLines.value.join("\n"));

/** Colors one shell line: comments, the export keyword, the variable name and its value. */
function shellParts(line: string): { text: string; cls: string }[] {
  if (line.startsWith("#")) return [{ text: line, cls: "text-fg-subtle italic" }];
  const m = /^(export )([A-Z_]+)(=)(.*)$/.exec(line);
  if (!m) return [{ text: line, cls: "text-fg-muted" }];
  return [
    { text: m[1]!, cls: "text-violet" },
    { text: m[2]!, cls: "text-accent" },
    { text: m[3]!, cls: "text-fg-subtle" },
    { text: m[4]!, cls: "text-success" },
  ];
}

const steps = computed(() => [
  { n: 1, icon: "user-plus" as IconName, title: t("public.home.steps.s1.title"), desc: t("public.home.steps.s1.desc") },
  { n: 2, icon: "key" as IconName, title: t("public.home.steps.s2.title"), desc: t("public.home.steps.s2.desc") },
  { n: 3, icon: "link" as IconName, title: t("public.home.steps.s3.title"), desc: t("public.home.steps.s3.desc") },
]);
</script>

<template>
  <PublicLayout>
    <!-- ============ Hero ============ -->
    <section class="relative overflow-hidden">
      <div class="hero-grid bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div class="relative mx-auto grid w-full max-w-6xl gap-14 px-4 pb-20 pt-12 sm:px-6 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:items-center lg:gap-12 lg:pb-28">
        <div class="min-w-0">
          <span class="hero-in inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/[0.08] px-3 py-1 text-xs font-medium text-accent">
            <span class="relative inline-flex h-1.5 w-1.5">
              <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            {{ t("public.home.eyebrow") }}
          </span>
          <h1
            class="hero-in mt-6 text-4xl font-bold leading-[1.08] tracking-tight [overflow-wrap:anywhere] sm:text-5xl lg:text-[3.6rem]"
            style="animation-delay: 60ms"
          >
            <span class="text-gradient">{{ portal.siteName }}</span>
          </h1>
          <p
            class="hero-in mt-5 max-w-xl whitespace-pre-line text-base leading-relaxed text-fg-muted [overflow-wrap:anywhere] sm:text-lg"
            style="animation-delay: 120ms"
          >
            {{ subtitle }}
          </p>
          <div class="hero-in mt-9 flex flex-wrap items-center gap-3" style="animation-delay: 180ms">
            <RouterLink :to="primaryCta.to" class="btn btn-primary group h-11 rounded-xl px-5 text-sm shadow-glow">
              {{ primaryCta.label }}
              <UiIcon :name="primaryCta.icon" :size="16" class="transition-transform duration-200 group-hover:translate-x-0.5" />
            </RouterLink>
            <RouterLink v-if="secondaryCta" :to="secondaryCta.to" class="btn btn-secondary h-11 rounded-xl px-5 text-sm">
              <UiIcon :name="secondaryCta.icon" :size="16" />
              {{ secondaryCta.label }}
            </RouterLink>
            <a
              v-if="settings?.docUrl"
              :href="settings.docUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-ghost h-11 rounded-xl px-4 text-sm"
            >
              <UiIcon name="book-open" :size="16" />
              {{ t("public.home.ctaDocs") }}
            </a>
          </div>
          <ul class="hero-in mt-9 grid max-w-md grid-cols-2 gap-x-6 gap-y-2.5 text-xs text-fg-muted sm:text-sm" style="animation-delay: 240ms">
            <li v-for="h in highlights" :key="h.icon" class="flex items-center gap-2">
              <span class="icon-chip icon-chip-accent h-6 w-6 rounded-md">
                <UiIcon :name="h.icon" :size="13" />
              </span>
              {{ h.label }}
            </li>
          </ul>
        </div>

        <div class="hero-in min-w-0" style="animation-delay: 200ms">
          <TerminalDemo :base-url="baseUrl" />
        </div>
      </div>
    </section>

    <!-- ============ Provider strip ============ -->
    <section class="relative border-y border-line/60 bg-surface/40 py-8" :aria-label="t('public.home.providers.title')">
      <p class="mb-5 text-center text-2xs font-semibold uppercase tracking-[0.16em] text-fg-subtle">
        {{ t("public.home.providers.title") }}
      </p>
      <div class="marquee mx-auto max-w-6xl overflow-hidden">
        <div class="marquee-track flex w-max">
          <ul class="flex shrink-0 items-center gap-3 pr-3">
            <li
              v-for="p in providers"
              :key="p"
              class="inline-flex items-center gap-2 rounded-full border border-line/80 bg-surface px-4 py-2 text-sm font-medium text-fg-muted shadow-card transition-colors duration-200 hover:border-line-strong hover:text-fg"
            >
              <PlatformIcon :platform="p" :size="16" />
              {{ platformShortLabel(p) }}
            </li>
          </ul>
          <ul class="marquee-dup flex shrink-0 items-center gap-3 pr-3" aria-hidden="true">
            <li
              v-for="p in providers"
              :key="`dup-${p}`"
              class="inline-flex items-center gap-2 rounded-full border border-line/80 bg-surface px-4 py-2 text-sm font-medium text-fg-muted shadow-card"
            >
              <PlatformIcon :platform="p" :size="16" />
              {{ platformShortLabel(p) }}
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ============ Admin content ============ -->
    <section v-if="homeContent" class="mx-auto w-full max-w-4xl px-4 pt-16 sm:px-6 sm:pt-20">
      <article v-reveal class="card relative overflow-hidden p-6 sm:p-8">
        <div class="about-wash pointer-events-none absolute inset-x-0 top-0 h-24" aria-hidden="true" />
        <p class="relative mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
          <UiIcon name="megaphone" :size="14" />
          {{ t("public.home.about") }}
        </p>
        <MarkdownView class="relative" :source="homeContent" />
      </article>
    </section>

    <!-- ============ Features ============ -->
    <section class="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
      <div v-reveal class="mx-auto max-w-2xl text-center">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{{ t("public.home.features.eyebrow") }}</p>
        <h2 class="mt-3 text-2xl font-bold tracking-tight text-fg sm:text-3xl">{{ t("public.home.features.title") }}</h2>
        <p class="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">{{ t("public.home.features.subtitle") }}</p>
      </div>

      <div class="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <!-- Unified endpoint -->
        <article v-reveal class="feature card card-hover group relative overflow-hidden p-6 md:col-span-2">
          <div class="feature-glow" aria-hidden="true" />
          <div class="relative grid items-center gap-6 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div>
              <span class="icon-chip icon-chip-accent h-10 w-10 rounded-xl"><UiIcon name="plug" :size="19" /></span>
              <h3 class="mt-4 text-base font-semibold text-fg">{{ t("public.home.features.unified.title") }}</h3>
              <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("public.home.features.unified.desc") }}</p>
            </div>
            <ul class="space-y-2 rounded-xl border border-line/70 bg-surface-2/50 p-3">
              <li
                v-for="e in endpoints"
                :key="e.path"
                class="flex min-w-0 items-center gap-2.5 rounded-lg bg-surface px-3 py-2 font-mono text-2xs shadow-card sm:text-xs"
              >
                <PlatformIcon :platform="e.platform" :size="14" class="text-fg-muted" />
                <span class="font-semibold text-accent">POST</span>
                <span class="min-w-0 flex-1 truncate text-fg">{{ e.path }}</span>
                <span class="hidden shrink-0 text-fg-subtle sm:inline">{{ e.sdk }}</span>
              </li>
            </ul>
          </div>
        </article>

        <!-- Egress isolation -->
        <article v-reveal="80" class="feature card card-hover group relative overflow-hidden p-6">
          <div class="feature-glow" aria-hidden="true" />
          <div class="relative">
            <span class="icon-chip icon-chip-info h-10 w-10 rounded-xl"><UiIcon name="shield" :size="19" /></span>
            <h3 class="mt-4 text-base font-semibold text-fg">{{ t("public.home.features.isolation.title") }}</h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("public.home.features.isolation.desc") }}</p>
            <ul class="mt-5 space-y-2">
              <li v-for="row in egress" :key="row.id" class="flex items-center gap-2 text-xs">
                <span class="inline-flex shrink-0 items-center gap-1.5 font-medium text-fg">
                  <span class="h-1.5 w-1.5 rounded-full bg-info" />
                  {{ t("public.home.features.isolation.account", { n: row.id }) }}
                </span>
                <span class="h-px min-w-[1rem] flex-1 border-t border-dashed border-line-strong" aria-hidden="true" />
                <span class="font-mono text-fg-muted">{{ row.ip }}</span>
                <span class="code-chip">{{ row.slot }}</span>
              </li>
            </ul>
          </div>
        </article>

        <!-- Metering -->
        <article v-reveal class="feature card card-hover group relative overflow-hidden p-6">
          <div class="feature-glow" aria-hidden="true" />
          <div class="relative">
            <span class="icon-chip icon-chip-success h-10 w-10 rounded-xl"><UiIcon name="gauge" :size="19" /></span>
            <h3 class="mt-4 text-base font-semibold text-fg">{{ t("public.home.features.metering.title") }}</h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("public.home.features.metering.desc") }}</p>
            <div class="mt-5 rounded-xl border border-line/70 bg-surface-2/50 p-3">
              <p class="text-gradient font-mono text-xl font-semibold tracking-tight">$0.000000001</p>
              <p class="mt-0.5 text-2xs text-fg-subtle">{{ t("public.home.features.metering.precision") }}</p>
              <dl class="mt-3 space-y-1.5 border-t border-line/70 pt-3">
                <div v-for="r in meterRows" :key="r.label" class="flex items-center justify-between gap-2 text-2xs">
                  <dt class="text-fg-muted">{{ r.label }} <span class="font-mono text-fg-subtle">× {{ r.tokens }}</span></dt>
                  <dd class="font-mono tabular-nums text-fg">{{ r.cost }}</dd>
                </div>
              </dl>
            </div>
          </div>
        </article>

        <!-- Scheduling -->
        <article v-reveal="80" class="feature card card-hover group relative overflow-hidden p-6 md:col-span-2">
          <div class="feature-glow" aria-hidden="true" />
          <div class="relative grid items-center gap-6 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div>
              <span class="icon-chip icon-chip-violet h-10 w-10 rounded-xl"><UiIcon name="route" :size="19" /></span>
              <h3 class="mt-4 text-base font-semibold text-fg">{{ t("public.home.features.scheduling.title") }}</h3>
              <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("public.home.features.scheduling.desc") }}</p>
            </div>
            <div class="relative rounded-xl border border-line/70 bg-surface-2/50 p-3">
              <span class="absolute bottom-6 left-8 top-6 w-px bg-line-strong" aria-hidden="true" />
              <ul class="relative space-y-2">
                <li
                  v-for="row in schedule"
                  :key="row.id"
                  class="flex items-center gap-3 rounded-lg bg-surface px-3 py-2.5 text-xs shadow-card"
                >
                  <UiIcon :name="row.icon" :size="16" :class="row.cls" />
                  <span class="font-medium text-fg">{{ t("public.home.features.isolation.account", { n: row.id }) }}</span>
                  <span class="ml-auto inline-flex rounded-full px-2 py-0.5 font-mono text-2xs ring-1 ring-inset" :class="row.badgeCls">
                    {{ row.badge }}
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- ============ Quick start ============ -->
    <section class="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6 sm:pb-24">
      <div class="grid items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
        <div v-reveal>
          <p class="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{{ t("public.home.steps.eyebrow") }}</p>
          <h2 class="mt-3 text-2xl font-bold tracking-tight text-fg sm:text-3xl">{{ t("public.home.steps.title") }}</h2>
          <ol class="relative mt-8 space-y-6">
            <span class="absolute bottom-5 left-[1.1875rem] top-5 w-px bg-gradient-to-b from-accent/50 via-line to-transparent" aria-hidden="true" />
            <li v-for="s in steps" :key="s.n" class="relative flex gap-4">
              <span class="relative z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-surface text-accent shadow-card">
                <UiIcon :name="s.icon" :size="17" />
              </span>
              <div class="min-w-0 pt-0.5">
                <p class="text-sm font-semibold text-fg">
                  <span class="mr-1.5 font-mono text-xs text-fg-subtle">0{{ s.n }}</span>{{ s.title }}
                </p>
                <p class="mt-1 text-sm leading-relaxed text-fg-muted">{{ s.desc }}</p>
              </div>
            </li>
          </ol>
        </div>

        <div v-reveal="100" class="dark min-w-0">
          <div class="overflow-hidden rounded-2xl border border-line bg-surface shadow-pop ring-1 ring-white/5">
            <div class="flex items-center justify-between gap-3 border-b border-line/80 bg-surface-2/60 px-4 py-2">
              <span class="inline-flex items-center gap-2 text-2xs font-medium text-fg-subtle">
                <UiIcon name="terminal" :size="13" />
                {{ t("public.home.steps.snippet") }}
              </span>
              <CopyButton :text="snippetText" />
            </div>
            <pre class="scrollbar-hide overflow-x-auto px-4 py-4 font-mono text-[11.5px] leading-[1.8] sm:text-[12.5px]"><code><template v-for="(line, i) in snippetLines" :key="i"><span v-for="(p, j) in shellParts(line)" :key="j" :class="p.cls">{{ p.text }}</span>{{ "\n" }}</template></code></pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Closing CTA ============ -->
    <section class="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6 sm:pb-24">
      <div v-reveal class="cta-band relative overflow-hidden rounded-3xl border border-accent/20 px-6 py-12 text-center sm:px-12 sm:py-16">
        <div class="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]" aria-hidden="true" />
        <div class="relative mx-auto max-w-xl">
          <h2 class="text-2xl font-bold tracking-tight text-fg sm:text-3xl">{{ t("public.home.cta.title") }}</h2>
          <p class="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">{{ t("public.home.cta.desc") }}</p>
          <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
            <RouterLink :to="primaryCta.to" class="btn btn-primary group h-11 rounded-xl px-5 text-sm shadow-glow">
              {{ primaryCta.label }}
              <UiIcon :name="primaryCta.icon" :size="16" class="transition-transform duration-200 group-hover:translate-x-0.5" />
            </RouterLink>
            <RouterLink v-if="secondaryCta" :to="secondaryCta.to" class="btn btn-secondary h-11 rounded-xl px-5 text-sm">
              <UiIcon :name="secondaryCta.icon" :size="16" />
              {{ secondaryCta.label }}
            </RouterLink>
          </div>
        </div>
      </div>
    </section>
  </PublicLayout>
</template>

<style scoped>
.hero-grid {
  mask-image: radial-gradient(ellipse 80% 70% at 50% 0%, black 25%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 80% 70% at 50% 0%, black 25%, transparent 75%);
}
.hero-in {
  animation: hero-in 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes hero-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.marquee {
  mask-image: linear-gradient(90deg, transparent, black 10%, black 90%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, black 10%, black 90%, transparent);
}
.marquee-track {
  animation: marquee 42s linear infinite;
}
.marquee:hover .marquee-track {
  animation-play-state: paused;
}
@keyframes marquee {
  to {
    transform: translateX(-50%);
  }
}

.about-wash {
  background: linear-gradient(180deg, rgb(var(--accent-glow) / 0.07), transparent);
}

.feature-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 300ms ease-out;
  background: radial-gradient(420px circle at 100% 0%, rgb(var(--accent-glow) / 0.1), transparent 60%);
}
.feature:hover .feature-glow {
  opacity: 1;
}

.cta-band {
  background:
    radial-gradient(ellipse 70% 90% at 50% 0%, rgb(var(--accent-glow) / 0.16), transparent 70%),
    linear-gradient(180deg, rgb(var(--surface)), rgb(var(--surface-2) / 0.6));
}

@media (prefers-reduced-motion: reduce) {
  .hero-in {
    animation: none;
  }
  .marquee {
    mask-image: none;
    -webkit-mask-image: none;
  }
  .marquee-track {
    animation: none;
    width: 100%;
    justify-content: center;
    padding: 0 1rem;
  }
  .marquee-track > ul:first-child {
    flex-wrap: wrap;
    justify-content: center;
    padding-right: 0;
    flex-shrink: 1;
  }
  .marquee-dup {
    display: none;
  }
}
</style>
