<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { availableLocales, setLocale, type LocaleCode } from "../i18n";
import UiIcon from "./ui/UiIcon.vue";

const { t, locale } = useI18n();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const current = computed(() => availableLocales.find((l) => l.code === locale.value) ?? availableLocales[0]!);

function choose(code: LocaleCode) {
  void setLocale(code);
  open.value = false;
}

function onPointerDown(ev: PointerEvent) {
  if (open.value && root.value && !root.value.contains(ev.target as Node)) open.value = false;
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="t('locale.label')"
      :title="current.name"
      @click="open = !open"
    >
      <UiIcon name="globe" :size="16" />
      <span class="text-xs">{{ current.short }}</span>
      <UiIcon
        name="chevron-down"
        :size="12"
        class="text-fg-subtle transition-transform duration-200"
        :class="{ 'rotate-180': open }"
      />
    </button>
    <div v-if="open" class="menu-panel absolute right-0 top-full z-50 mt-2 w-40 origin-top-right animate-scale-in" role="menu">
      <button
        v-for="l in availableLocales"
        :key="l.code"
        type="button"
        role="menuitemradio"
        :aria-checked="l.code === locale"
        class="menu-item justify-between"
        :class="l.code === locale ? '!bg-accent/10 !text-accent' : ''"
        @click="choose(l.code)"
      >
        {{ l.name }}
        <UiIcon v-if="l.code === locale" name="check" :size="14" />
      </button>
    </div>
  </div>
</template>
