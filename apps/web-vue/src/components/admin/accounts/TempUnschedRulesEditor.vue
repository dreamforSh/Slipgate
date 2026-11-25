<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UiIcon from "../../ui/UiIcon.vue";
import { MAX_TEMP_UNSCHED_RULES, blankRule, ruleProblem, type EditableRule } from "./tempUnschedRules";

/**
 * Editor for an account's temporary-unschedulable rules (sub2api style): HTTP status (blank = any
 * error), body keywords, cooldown minutes and a note. slipgate-net checks them on every
 * pre-first-byte upstream error; the first match cools the account down and fails over.
 */
const rules = defineModel<EditableRule[]>({ required: true });

const { t } = useI18n();

const PRESETS: { key: string; rule: () => EditableRule }[] = [
  { key: "overloaded", rule: () => ({ statusCode: "529", keywordsText: "", durationMinutes: 10, description: t("accounts.rules.presetLabels.overloaded") }) },
  {
    key: "orgDisabled",
    rule: () => ({
      statusCode: "400",
      keywordsText: "organization has been disabled",
      durationMinutes: 1440,
      description: t("accounts.rules.presetLabels.orgDisabled"),
    }),
  },
  { key: "forbidden", rule: () => ({ statusCode: "403", keywordsText: "", durationMinutes: 60, description: t("accounts.rules.presetLabels.forbidden") }) },
];

function add(rule: EditableRule = blankRule()) {
  if (rules.value.length >= MAX_TEMP_UNSCHED_RULES) return;
  rules.value = [...rules.value, rule];
}

function remove(index: number) {
  rules.value = rules.value.filter((_, i) => i !== index);
}

function problemText(rule: EditableRule): string {
  const p = ruleProblem(rule);
  return p ? t(`accounts.rules.problems.${p}`) : "";
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-2xs leading-relaxed text-fg-subtle">{{ t("accounts.rules.hint") }}</p>

    <div class="space-y-2.5">
      <div
        v-for="(rule, index) in rules"
        :key="index"
        class="rounded-lg border bg-surface-2/40 p-3"
        :class="problemText(rule) ? 'border-danger/40' : 'border-line'"
      >
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-[6rem_minmax(0,1fr)_7rem]">
          <label class="block min-w-0">
            <span class="label">{{ t("accounts.rules.status") }}</span>
            <input
              v-model.trim="rule.statusCode"
              type="text"
              inputmode="numeric"
              maxlength="3"
              :placeholder="t('accounts.rules.anyStatus')"
              class="input input-sm font-mono"
            />
          </label>
          <label class="col-span-2 block min-w-0 sm:col-span-1 sm:row-start-1 sm:col-start-2">
            <span class="label">{{ t("accounts.rules.keywords") }}</span>
            <input
              v-model="rule.keywordsText"
              type="text"
              maxlength="1000"
              :placeholder="t('accounts.rules.keywordsPlaceholder')"
              class="input input-sm"
            />
          </label>
          <label class="block min-w-0 sm:row-start-1 sm:col-start-3">
            <span class="label">{{ t("accounts.rules.duration") }}</span>
            <input v-model.number="rule.durationMinutes" type="number" min="1" max="10080" class="input input-sm font-mono" />
          </label>
        </div>
        <div class="mt-2.5 flex items-center gap-2">
          <input
            v-model="rule.description"
            type="text"
            maxlength="100"
            :placeholder="t('accounts.rules.descriptionPlaceholder')"
            :aria-label="t('accounts.rules.description')"
            class="input input-sm min-w-0 flex-1"
          />
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm shrink-0 hover:!bg-danger/10 hover:!text-danger"
            :title="t('accounts.rules.remove')"
            :aria-label="t('accounts.rules.remove')"
            @click="remove(index)"
          >
            <UiIcon name="trash" :size="14" />
          </button>
        </div>
        <p v-if="problemText(rule)" class="mt-1.5 text-2xs text-danger">{{ problemText(rule) }}</p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <button type="button" class="btn btn-secondary btn-xs" :disabled="rules.length >= MAX_TEMP_UNSCHED_RULES" @click="add()">
        <UiIcon name="plus" :size="12" />
        {{ t("accounts.rules.add") }}
      </button>
      <span class="text-2xs text-fg-subtle">{{ t("accounts.rules.presets") }}</span>
      <button
        v-for="p in PRESETS"
        :key="p.key"
        type="button"
        class="btn btn-ghost btn-xs"
        :disabled="rules.length >= MAX_TEMP_UNSCHED_RULES"
        @click="add(p.rule())"
      >
        {{ t(`accounts.rules.presetLabels.${p.key}`) }}
      </button>
    </div>
  </div>
</template>
