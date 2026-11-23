<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/** Four-segment strength meter: length plus character variety (a hint, not a policy). */
const props = defineProps<{ password: string }>();
const { t } = useI18n();

const score = computed(() => {
  const pw = props.password;
  if (!pw) return 0;
  if (pw.length < 8) return 1;
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  let s = 1;
  if (pw.length >= 12) s++;
  if (variety >= 2) s++;
  if (variety >= 3) s++;
  return s;
});

const LEVELS = [
  { key: "empty", bar: "bg-surface-3", text: "text-fg-subtle" },
  { key: "weak", bar: "bg-danger", text: "text-danger" },
  { key: "fair", bar: "bg-warning", text: "text-warning" },
  { key: "good", bar: "bg-info", text: "text-info" },
  { key: "strong", bar: "bg-success", text: "text-success" },
] as const;

const level = computed(() => LEVELS[score.value]!);
</script>

<template>
  <div class="mt-2" aria-live="polite">
    <div class="flex gap-1" aria-hidden="true">
      <span v-for="i in 4" :key="i" class="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
        <span
          class="block h-full rounded-full transition-[width,background-color] duration-300 ease-out"
          :class="level.bar"
          :style="{ width: i <= score ? '100%' : '0%' }"
        />
      </span>
    </div>
    <p class="mt-1.5 flex items-center justify-between gap-2 text-2xs">
      <span class="text-fg-subtle">{{ t("profile.password.strengthHint") }}</span>
      <span v-if="password" class="font-medium transition-colors" :class="level.text">
        {{ t(`profile.password.strength.${level.key}`) }}
      </span>
    </p>
  </div>
</template>
