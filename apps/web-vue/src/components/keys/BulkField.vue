<script setup lang="ts">
import UiIcon, { type IconName } from "../ui/UiIcon.vue";

/**
 * One "tick to change" field in the bulk editor. The body stays visible but dimmed while
 * unticked; focusing anything inside ticks it so people can just start typing.
 */
const checked = defineModel<boolean>("checked", { required: true });
defineProps<{ id: string; label: string; icon: IconName; hint?: string }>();
</script>

<template>
  <div
    class="rounded-lg border p-3 transition-[border-color,background-color] duration-200"
    :class="checked ? 'border-accent/40 bg-accent/[0.04]' : 'border-line/80'"
  >
    <label :for="id" class="flex cursor-pointer select-none items-center gap-2.5">
      <input :id="id" v-model="checked" type="checkbox" class="checkbox" />
      <UiIcon :name="icon" :size="14" :class="checked ? 'text-accent' : 'text-fg-subtle'" />
      <span class="text-sm font-medium text-fg">{{ label }}</span>
      <span v-if="hint" class="ml-auto hidden truncate text-2xs text-fg-subtle sm:inline">{{ hint }}</span>
    </label>
    <div
      class="mt-3 transition-opacity duration-200 sm:pl-[1.625rem]"
      :class="checked ? '' : 'opacity-55'"
      @focusin="checked = true"
    >
      <slot />
    </div>
  </div>
</template>
