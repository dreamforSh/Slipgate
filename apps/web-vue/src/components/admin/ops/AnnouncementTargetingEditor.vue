<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { announcementUsdToNano, type GroupItem } from "@slipgate/contracts";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiIcon from "../../ui/UiIcon.vue";
import {
  BALANCE_OPERATORS,
  formatThresholdUsd,
  newCondition,
  newGroup,
  TARGETING_MAX_CONDITIONS,
  TARGETING_MAX_GROUP_IDS,
  TARGETING_MAX_GROUPS,
  targetingSentence,
  type ConditionIssue,
  type DraftCondition,
  type DraftGroup,
  type DraftIssues,
  type TargetingDraft,
} from "./announcementTargeting";
import UiSelect from "../../ui/UiSelect.vue";

/**
 * Targeting rule editor: "everyone in the audience" or OR-ed condition groups whose conditions
 * (subscription group membership, wallet balance threshold) must all hold. Edits the draft in place.
 */
const props = withDefaults(
  defineProps<{
    /** Subscription groups that can be picked. */
    groups: GroupItem[];
    /** Every admin group by id (names for stale selections). */
    groupsById: ReadonlyMap<string, GroupItem>;
    groupsLoading: boolean;
    groupsFailed: boolean;
    issues: DraftIssues;
    showErrors: boolean;
    /** Label of the role audience the rule narrows ("所有人", "普通用户"…). */
    audienceLabel: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const draft = defineModel<TargetingDraft>({ required: true });
const emit = defineEmits<{ (e: "retry-groups"): void }>();

const { t } = useI18n();
const uid = useId();

type Mode = "all" | "custom";
const mode = computed<Mode>({
  get: () => (draft.value.enabled ? "custom" : "all"),
  set: (next) => {
    if (props.disabled) return;
    draft.value.enabled = next === "custom";
    if (next === "custom" && draft.value.groups.length === 0) draft.value.groups.push(starterGroup());
  },
});
const modeOptions = computed(() => [
  { value: "all" as const, label: t("annAdmin.targeting.modes.all") },
  { value: "custom" as const, label: t("annAdmin.targeting.modes.custom") },
]);
const operatorOptions = computed(() => BALANCE_OPERATORS.map((value) => ({ value, label: t(`annAdmin.targeting.ops.${value}`) })));

/** Without any subscription group, a balance condition is the only one that can be completed. */
function starterGroup(): DraftGroup {
  const g = newGroup();
  if (props.groups.length === 0 && !props.groupsLoading) g.conditions = [newCondition("balance")];
  return g;
}

function addGroup() {
  if (draft.value.groups.length >= TARGETING_MAX_GROUPS) return;
  draft.value.groups.push(starterGroup());
}
function removeGroup(key: number) {
  draft.value.groups = draft.value.groups.filter((g) => g.key !== key);
  if (draft.value.groups.length === 0) draft.value.enabled = false;
}
function addCondition(g: DraftGroup) {
  if (g.conditions.length >= TARGETING_MAX_CONDITIONS) return;
  g.conditions.push(newCondition(props.groups.length > 0 || props.groupsLoading ? "subscription" : "balance"));
}
function removeCondition(g: DraftGroup, key: number) {
  g.conditions = g.conditions.filter((c) => c.key !== key);
}
function toggleGroupId(c: DraftCondition, id: string) {
  if (props.disabled) return;
  c.groupIds = c.groupIds.includes(id) ? c.groupIds.filter((x) => x !== id) : [...c.groupIds, id];
}

/** Selected ids that are no longer pickable (deleted, or switched to balance billing). */
function staleIds(c: DraftCondition): string[] {
  const pickable = new Set(props.groups.map((g) => g.id));
  return c.groupIds.filter((id) => !pickable.has(id));
}

function groupName(id: string): string {
  return props.groupsById.get(id)?.name ?? t("annAdmin.targeting.unknownGroup");
}

const issueText = computed<Record<ConditionIssue, string>>(() => ({
  groups: t("annAdmin.targeting.errors.groups"),
  unknownGroups: t("annAdmin.targeting.errors.unknownGroups"),
  tooManyGroups: t("annAdmin.targeting.errors.tooManyGroups", { max: TARGETING_MAX_GROUP_IDS }),
  amount: t("annAdmin.targeting.errors.amount"),
}));
const conditionIssue = (c: DraftCondition) => (props.showErrors ? props.issues.conditions.get(c.key) : undefined);
const groupEmpty = (g: DraftGroup) => props.showErrors && props.issues.emptyGroups.has(g.key);

/* ---------------- Live summary ---------------- */

function phrase(c: DraftCondition): string {
  if (c.type === "subscription") {
    const names = c.groupIds.map(groupName);
    return t("annAdmin.targeting.summary.subscription", {
      groups: names.length > 0 ? names.join(t("annAdmin.targeting.summary.groupSep")) : "…",
    });
  }
  const nano = announcementUsdToNano(c.usd);
  return t("annAdmin.targeting.summary.balance", {
    op: t(`annAdmin.targeting.ops.${c.operator}`),
    amount: nano === null ? "…" : formatThresholdUsd(nano),
  });
}

const sentence = computed(() => {
  const parts = draft.value.groups.filter((g) => g.conditions.length > 0).map((g) => g.conditions.map(phrase));
  return parts.length > 0 ? targetingSentence(parts, t) : "";
});

const chipBase =
  "inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-[color,background-color,border-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";
</script>

<template>
  <section
    class="rounded-xl border bg-surface-2/30 transition-colors duration-200 motion-reduce:transition-none"
    :class="showErrors && issues.count > 0 ? 'border-danger/40' : 'border-line'"
    :aria-labelledby="`${uid}-title`"
  >
    <div class="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <p :id="`${uid}-title`" class="flex items-center gap-2 text-sm font-medium text-fg">
          <UiIcon name="filter" :size="14" class="text-violet" />
          {{ t("annAdmin.targeting.title") }}
        </p>
        <p class="mt-0.5 text-xs text-fg-subtle">{{ t("annAdmin.targeting.hint") }}</p>
      </div>
      <SegmentedControl
        v-model="mode"
        :options="modeOptions"
        :aria-label="t('annAdmin.targeting.title')"
        class="shrink-0 self-start sm:self-auto"
      />
    </div>

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0"
    >
      <fieldset v-if="draft.enabled" :disabled="disabled" class="min-w-0 space-y-3 border-t border-line/70 px-3.5 pb-3.5 pt-3">
        <legend class="sr-only">{{ t("annAdmin.targeting.title") }}</legend>

        <p v-if="showErrors && issues.emptyRule" class="flex items-center gap-1.5 text-xs text-danger" role="alert">
          <UiIcon name="alert" :size="12" />
          {{ t("annAdmin.targeting.errors.emptyRule") }}
        </p>

        <TransitionGroup
          tag="div"
          class="space-y-0"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          enter-from-class="opacity-0 -translate-y-1"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          leave-to-class="opacity-0"
          move-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
        >
          <div v-for="(g, gi) in draft.groups" :key="g.key">
            <div v-if="gi > 0" class="flex items-center gap-2 py-2" aria-hidden="true">
              <span class="h-px flex-1 bg-line" />
              <span class="rounded-full bg-violet/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-violet ring-1 ring-inset ring-violet/20">
                {{ t("annAdmin.targeting.or") }}
              </span>
              <span class="h-px flex-1 bg-line" />
            </div>

            <div
              class="rounded-lg border bg-surface p-3 shadow-sm dark:bg-surface-2/40"
              :class="groupEmpty(g) ? 'border-danger/50' : 'border-line'"
              role="group"
              :aria-label="t('annAdmin.targeting.group', { n: gi + 1 })"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-xs font-semibold text-fg">
                    {{ t("annAdmin.targeting.group", { n: gi + 1 }) }}
                    <span class="ml-1 font-normal tabular-nums text-fg-subtle">
                      {{ g.conditions.length }}/{{ TARGETING_MAX_CONDITIONS }}
                    </span>
                  </p>
                  <p class="mt-0.5 text-2xs text-fg-subtle">{{ t("annAdmin.targeting.groupHint") }}</p>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-icon btn-xs -mr-1 -mt-1 hover:!bg-danger/10 hover:!text-danger"
                  :title="t('annAdmin.targeting.removeGroup')"
                  :aria-label="t('annAdmin.targeting.removeGroup')"
                  @click="removeGroup(g.key)"
                >
                  <UiIcon name="trash" :size="13" />
                </button>
              </div>

              <p v-if="groupEmpty(g)" class="mt-2 flex items-center gap-1.5 text-xs text-danger" role="alert">
                <UiIcon name="alert" :size="12" />
                {{ t("annAdmin.targeting.errors.emptyGroup") }}
              </p>

              <TransitionGroup
                tag="ul"
                class="mt-3 space-y-2"
                enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                enter-from-class="opacity-0 -translate-y-1"
                leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
                leave-to-class="opacity-0"
              >
                <li v-for="(c, ci) in g.conditions" :key="c.key" class="relative">
                  <span
                    v-if="ci > 0"
                    class="mb-2 inline-flex rounded-full bg-accent/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-accent ring-1 ring-inset ring-accent/20"
                    aria-hidden="true"
                  >
                    {{ t("annAdmin.targeting.and") }}
                  </span>
                  <div
                    class="flex flex-col gap-2.5 rounded-lg border bg-surface-2/40 p-2.5 sm:flex-row sm:items-start"
                    :class="conditionIssue(c) ? 'border-danger/50' : 'border-line/70'"
                  >
                    <label class="block shrink-0 sm:w-36">
                      <span class="sr-only">{{ t("annAdmin.targeting.conditionType") }}</span>
                      <UiSelect v-model="c.type" class="select input-sm">
                        <option value="subscription">{{ t("annAdmin.targeting.types.subscription") }}</option>
                        <option value="balance">{{ t("annAdmin.targeting.types.balance") }}</option>
                      </UiSelect>
                    </label>

                    <!-- Subscription groups -->
                    <div v-if="c.type === 'subscription'" class="min-w-0 flex-1">
                      <div class="mb-1.5 flex items-baseline justify-between gap-2">
                        <span :id="`${uid}-pick-${c.key}`" class="text-2xs text-fg-subtle">{{ t("annAdmin.targeting.pickGroups") }}</span>
                        <span v-if="c.groupIds.length" class="shrink-0 text-2xs tabular-nums text-fg-subtle">
                          {{ t("annAdmin.targeting.selectedGroups", { n: c.groupIds.length }) }}
                        </span>
                      </div>

                      <div v-if="groupsLoading && groups.length === 0" class="flex flex-wrap gap-1.5" aria-busy="true">
                        <span v-for="i in 3" :key="i" class="h-7 w-20 rounded-full bg-surface-2 motion-safe:animate-pulse" />
                        <span class="sr-only">{{ t("annAdmin.targeting.groupsLoading") }}</span>
                      </div>
                      <div v-else-if="groupsFailed && groups.length === 0" class="flex flex-wrap items-center gap-2 text-xs text-danger">
                        <UiIcon name="alert" :size="12" />
                        {{ t("annAdmin.targeting.groupsError") }}
                        <button type="button" class="btn btn-secondary btn-xs" @click="emit('retry-groups')">
                          <UiIcon name="refresh" :size="12" />
                          {{ t("annAdmin.targeting.retry") }}
                        </button>
                      </div>
                      <div
                        v-else
                        class="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto"
                        role="group"
                        :aria-labelledby="`${uid}-pick-${c.key}`"
                      >
                        <button
                          v-for="grp in groups"
                          :key="grp.id"
                          type="button"
                          role="checkbox"
                          :aria-checked="c.groupIds.includes(grp.id)"
                          :class="[
                            chipBase,
                            c.groupIds.includes(grp.id)
                              ? 'border-violet/30 bg-violet/10 text-violet'
                              : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg dark:bg-surface-2/60',
                          ]"
                          :title="grp.description || grp.name"
                          @click="toggleGroupId(c, grp.id)"
                        >
                          <UiIcon :name="c.groupIds.includes(grp.id) ? 'check' : 'plus'" :size="12" />
                          <span class="truncate">{{ grp.name }}</span>
                          <span v-if="!grp.enabled" class="text-2xs text-fg-subtle">· {{ t("common.disabled") }}</span>
                        </button>
                        <button
                          v-for="id in staleIds(c)"
                          :key="`stale-${id}`"
                          type="button"
                          :class="[chipBase, 'border-danger/30 bg-danger/10 text-danger']"
                          :title="id"
                          :aria-label="t('annAdmin.targeting.removeStale', { name: groupName(id) })"
                          @click="toggleGroupId(c, id)"
                        >
                          <UiIcon name="x" :size="12" />
                          <span class="truncate">{{ groupName(id) }}</span>
                        </button>
                        <p v-if="groups.length === 0 && staleIds(c).length === 0" class="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                          <UiIcon name="layers" :size="13" />
                          {{ t("annAdmin.targeting.noGroups") }}
                          <!-- A new tab: leaving would discard the announcement being written. -->
                          <RouterLink
                            to="/admin/groups"
                            target="_blank"
                            rel="noopener"
                            class="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                          >
                            {{ t("annAdmin.targeting.goGroups") }}
                            <UiIcon name="external-link" :size="11" />
                          </RouterLink>
                        </p>
                      </div>
                    </div>

                    <!-- Balance threshold -->
                    <div v-else class="flex min-w-0 flex-1 gap-2">
                      <label class="block w-28 shrink-0 sm:w-36">
                        <span class="sr-only">{{ t("annAdmin.targeting.operator") }}</span>
                        <UiSelect v-model="c.operator" class="select input-sm">
                          <option v-for="o in operatorOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                        </UiSelect>
                      </label>
                      <label class="relative block min-w-0 flex-1">
                        <span class="sr-only">{{ t("annAdmin.targeting.amount") }}</span>
                        <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle" aria-hidden="true">
                          USD
                        </span>
                        <input
                          v-model.trim="c.usd"
                          type="text"
                          inputmode="decimal"
                          autocomplete="off"
                          maxlength="24"
                          class="input input-sm pl-11 tabular-nums"
                          :class="conditionIssue(c) === 'amount' ? '!border-danger' : ''"
                          :placeholder="t('annAdmin.targeting.amountPlaceholder')"
                          :aria-invalid="conditionIssue(c) === 'amount' || undefined"
                        />
                      </label>
                    </div>

                    <button
                      type="button"
                      class="btn btn-ghost btn-icon btn-xs self-end hover:!bg-danger/10 hover:!text-danger sm:self-start"
                      :title="t('annAdmin.targeting.removeCondition')"
                      :aria-label="t('annAdmin.targeting.removeCondition')"
                      @click="removeCondition(g, c.key)"
                    >
                      <UiIcon name="x" :size="14" />
                    </button>
                  </div>
                  <p v-if="conditionIssue(c)" class="mt-1 flex items-center gap-1 text-xs text-danger" role="alert">
                    <UiIcon name="alert" :size="12" />
                    {{ issueText[conditionIssue(c)!] }}
                  </p>
                </li>
              </TransitionGroup>

              <button
                type="button"
                class="btn btn-ghost btn-xs mt-2 text-accent hover:!text-accent"
                :disabled="g.conditions.length >= TARGETING_MAX_CONDITIONS"
                @click="addCondition(g)"
              >
                <UiIcon name="plus" :size="13" />
                {{ t("annAdmin.targeting.addCondition") }}
              </button>
            </div>
          </div>
        </TransitionGroup>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="draft.groups.length >= TARGETING_MAX_GROUPS" @click="addGroup">
            <UiIcon name="plus" :size="13" />
            {{ t("annAdmin.targeting.addGroup") }}
          </button>
          <span class="text-2xs text-fg-subtle">
            {{ t("annAdmin.targeting.limits", { groups: TARGETING_MAX_GROUPS, conditions: TARGETING_MAX_CONDITIONS }) }}
          </span>
        </div>
      </fieldset>
    </Transition>

    <div class="flex items-start gap-2 rounded-b-xl border-t border-line/70 bg-surface-2/40 px-3.5 py-2.5 text-xs" aria-live="polite">
      <UiIcon name="users" :size="13" class="mt-px shrink-0 text-fg-subtle" />
      <p class="min-w-0 break-words text-fg-muted">
        <template v-if="!draft.enabled">{{ t("annAdmin.targeting.previewAll", { audience: audienceLabel }) }}</template>
        <template v-else>
          {{ t("annAdmin.targeting.previewCustom", { audience: audienceLabel }) }}
          <span class="font-medium text-fg">{{ sentence || "…" }}</span>
        </template>
      </p>
    </div>
  </section>
</template>
