<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import { TESTABLE_HOOK, type PluginItem, type PluginPatchResponse } from "./toolsTypes";

/**
 * One registered plugin: identity, hooks and an on/off switch, with an expandable settings
 * form built from the fields the plugin declares. Secret fields are write-only: blank keeps
 * the stored value, "Clear" (applied on save) removes it.
 */
const props = defineProps<{ plugin: PluginItem }>();
const emit = defineEmits<{ (e: "updated", item: PluginItem): void }>();

const { t, te } = useI18n();
const toast = useToastStore();

const base = computed(() => `/api/v1/admin/plugins/${encodeURIComponent(props.plugin.name)}`);
const idPrefix = computed(() => `plugin-${props.plugin.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`);

/* ---------------- Enable switch (optimistic) ---------------- */

const pendingEnabled = ref<boolean | null>(null);
const enabledView = computed(() => pendingEnabled.value ?? props.plugin.enabled);

async function toggle(next: boolean) {
  if (pendingEnabled.value !== null) return;
  pendingEnabled.value = next;
  try {
    const res = await apiJson<PluginPatchResponse>(base.value, {
      method: "PATCH",
      body: { enabled: next },
      fallbackError: t("adminTools.plugins.errors.toggle"),
    });
    emit("updated", res.item ?? { ...props.plugin, enabled: next });
    toast.success(t(next ? "adminTools.plugins.toggle.on" : "adminTools.plugins.toggle.off", { name: props.plugin.name }));
    if (!next) testResult.value = null;
  } catch (err) {
    toast.error(errorText(err, t("adminTools.plugins.errors.toggle")));
  } finally {
    pendingEnabled.value = null;
  }
}

/* ---------------- Localized built-in copy ---------------- */

/** Built-in plugins ship English metadata; the console overrides it per locale when it knows the plugin. */
const builtinKey = computed(
  () => `adminTools.plugins.builtin.${props.plugin.name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`,
);

function pluginText(path: string, fallback: string): string;
function pluginText(path: string, fallback: string | undefined): string | undefined;
function pluginText(path: string, fallback: string | undefined): string | undefined {
  const key = `${builtinKey.value}.${path}`;
  return te(key) ? t(key) : fallback;
}

const description = computed(() => pluginText("description", props.plugin.description || undefined));

/* ---------------- Hooks ---------------- */

function hookLabel(hook: string): string {
  const key = `adminTools.plugins.hooks.${hook}`;
  return te(key) ? t(key) : hook;
}

const testable = computed(() => props.plugin.hooks.includes(TESTABLE_HOOK));

/* ---------------- Settings draft ---------------- */

const expanded = ref(false);
const saving = ref(false);
/** Non-secret fields hold their edited value; secret fields hold a new value to store ("" = keep). */
const values = reactive<Record<string, string>>({});
const clearing = ref(new Set<string>());
const shown = ref(new Set<string>());

const secretFields = computed(() => props.plugin.settings.filter((f) => f.secret));
const secretsSetCount = computed(() => secretFields.value.filter((f) => props.plugin.secretsSet[f.key]).length);

function resetDraft(item: PluginItem = props.plugin) {
  for (const key of Object.keys(values)) delete values[key];
  for (const f of item.settings) values[f.key] = f.secret ? "" : (item.config[f.key] ?? "");
  clearing.value = new Set();
  shown.value = new Set();
}

// Reset only when the saved settings change, so toggling the plugin keeps unsaved edits.
watch(
  () => JSON.stringify([props.plugin.settings.map((f) => f.key), props.plugin.config, props.plugin.secretsSet]),
  () => resetDraft(),
  { immediate: true },
);

const dirty = computed(() =>
  props.plugin.settings.some((f) =>
    f.secret
      ? (values[f.key] ?? "") !== "" || clearing.value.has(f.key)
      : (values[f.key] ?? "").trim() !== (props.plugin.config[f.key] ?? ""),
  ),
);

function markClear(key: string) {
  values[key] = "";
  clearing.value = new Set(clearing.value).add(key);
}

function undoClear(key: string) {
  const next = new Set(clearing.value);
  next.delete(key);
  clearing.value = next;
}

function toggleShown(key: string) {
  const next = new Set(shown.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  shown.value = next;
}

async function save() {
  if (!dirty.value || saving.value) return;
  const config: Record<string, string> = {};
  for (const f of props.plugin.settings) {
    const v = values[f.key] ?? "";
    if (f.secret) {
      // Omitted keeps the stored secret; "" clears it.
      if (v) config[f.key] = v;
      else if (clearing.value.has(f.key)) config[f.key] = "";
    } else {
      config[f.key] = v.trim();
    }
  }
  saving.value = true;
  try {
    const res = await apiJson<PluginPatchResponse>(base.value, {
      method: "PATCH",
      body: { config },
      fallbackError: t("adminTools.plugins.errors.save"),
    });
    const item = res.item ?? props.plugin;
    emit("updated", item);
    resetDraft(item);
    toast.success(t("adminTools.plugins.settings.saved", { name: props.plugin.name }));
  } catch (err) {
    toast.error(errorText(err, t("adminTools.plugins.errors.save")));
  } finally {
    saving.value = false;
  }
}

/* ---------------- Test event ---------------- */

const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function sendTest() {
  if (testing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    await apiJson<{ ok: boolean }>(`${base.value}/test`, {
      method: "POST",
      fallbackError: t("adminTools.plugins.errors.test"),
    });
    testResult.value = { ok: true, message: "" };
  } catch (err) {
    testResult.value = { ok: false, message: errorText(err, t("adminTools.plugins.errors.test")) };
  } finally {
    testing.value = false;
  }
}

const testTitle = computed(() => {
  if (!props.plugin.enabled) return t("adminTools.plugins.test.disabledHint");
  return dirty.value ? t("adminTools.plugins.test.dirtyHint") : t("adminTools.plugins.test.hint");
});
</script>

<template>
  <article class="card flex min-w-0 flex-col overflow-hidden" :class="enabledView ? '' : 'bg-surface-2/30 dark:bg-surface/50'">
    <!-- Identity -->
    <div class="flex items-start gap-3 p-5">
      <span
        class="icon-chip h-10 w-10 transition-colors duration-200"
        :class="enabledView ? 'icon-chip-accent' : ''"
      >
        <UiIcon name="plug" :size="18" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 class="min-w-0 truncate font-mono text-sm font-semibold text-fg" :title="plugin.name">{{ plugin.name }}</h3>
          <span class="code-chip" :title="t('adminTools.plugins.version', { version: plugin.version })">v{{ plugin.version }}</span>
        </div>
        <p class="mt-1 text-xs leading-relaxed" :class="description ? 'text-fg-muted' : 'italic text-fg-subtle'">
          {{ description || t("adminTools.plugins.noDescription") }}
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-1.5">
          <span class="sr-only">{{ t("adminTools.plugins.hooks.title") }}</span>
          <UiBadge v-for="hook in plugin.hooks" :key="hook" :tone="enabledView ? 'info' : 'neutral'" :title="hook">
            {{ hookLabel(hook) }}
          </UiBadge>
          <span v-if="plugin.hooks.length === 0" class="text-2xs text-fg-subtle">{{ t("adminTools.plugins.hooks.none") }}</span>
        </div>
      </div>
      <UiSwitch
        class="shrink-0 pt-0.5"
        :model-value="enabledView"
        :label="enabledView ? t('common.enabled') : t('common.disabled')"
        :disabled="pendingEnabled !== null"
        @update:model-value="toggle"
      />
    </div>

    <!-- Test result -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="-translate-y-1 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div v-if="testResult" class="px-5 pb-4">
        <UiAlert
          :tone="testResult.ok ? 'success' : 'danger'"
          :title="testResult.ok ? t('adminTools.plugins.test.okTitle') : t('adminTools.plugins.test.failTitle')"
        >
          <span :class="testResult.ok ? '' : 'font-mono text-xs'">
            {{ testResult.ok ? t("adminTools.plugins.test.okBody") : testResult.message }}
          </span>
          <template #action>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs -mr-1 -mt-1 shrink-0"
              :aria-label="t('common.close')"
              @click="testResult = null"
            >
              <UiIcon name="x" :size="13" />
            </button>
          </template>
        </UiAlert>
      </div>
    </Transition>

    <!-- Action bar -->
    <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-line/70 bg-surface-2/40 px-3 py-2 sm:px-4">
      <button
        v-if="plugin.settings.length"
        type="button"
        class="btn btn-ghost btn-sm"
        :aria-expanded="expanded"
        :aria-controls="`${idPrefix}-settings`"
        @click="expanded = !expanded"
      >
        <UiIcon name="sliders" :size="14" />
        {{ expanded ? t("adminTools.plugins.settings.close") : t("adminTools.plugins.settings.open") }}
        <span class="hidden font-normal text-fg-subtle sm:inline">
          · {{ t("adminTools.plugins.settings.summary", { n: plugin.settings.length }) }}
        </span>
        <UiIcon
          name="chevron-down"
          :size="13"
          class="transition-transform duration-200 motion-reduce:transition-none"
          :class="expanded ? 'rotate-180' : ''"
        />
      </button>
      <span v-else class="px-2 text-xs text-fg-subtle">{{ t("adminTools.plugins.settings.none") }}</span>
      <UiBadge
        v-if="secretFields.length"
        :tone="secretsSetCount === secretFields.length ? 'success' : 'neutral'"
        :title="t('adminTools.plugins.settings.secretHint')"
      >
        {{ t("adminTools.plugins.settings.secretsSummary", { set: secretsSetCount, total: secretFields.length }) }}
      </UiBadge>
      <UiBadge v-if="dirty && !expanded" tone="warning" dot>{{ t("adminTools.plugins.settings.dirty") }}</UiBadge>
      <button
        v-if="testable"
        type="button"
        class="btn btn-secondary btn-sm ml-auto"
        :disabled="testing || !plugin.enabled || pendingEnabled !== null"
        :title="testTitle"
        @click="sendTest"
      >
        <UiIcon :name="testing ? 'loader' : 'zap'" :size="14" :spin="testing" />
        {{ testing ? t("adminTools.plugins.test.running") : t("adminTools.plugins.test.action") }}
      </button>
    </div>

    <!-- Settings (grid-rows trick animates the height; instant under reduced motion) -->
    <div
      v-if="plugin.settings.length"
      :id="`${idPrefix}-settings`"
      class="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
      :class="expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
    >
      <div class="min-h-0 overflow-hidden">
        <form class="space-y-4 border-t border-line/70 px-5 py-4" :inert="!expanded" @submit.prevent="save">
          <div v-for="field in plugin.settings" :key="field.key" class="min-w-0">
            <div class="mb-1.5 flex min-w-0 items-center justify-between gap-2">
              <label :for="`${idPrefix}-${field.key}`" class="truncate text-xs font-medium text-fg-muted">{{ pluginText(`fields.${field.key}.label`, field.label) }}</label>
              <UiBadge
                v-if="field.secret"
                :tone="clearing.has(field.key) ? 'warning' : plugin.secretsSet[field.key] ? 'success' : 'neutral'"
                dot
              >
                {{
                  plugin.secretsSet[field.key]
                    ? t("adminTools.plugins.settings.secretSet")
                    : t("adminTools.plugins.settings.secretUnset")
                }}
              </UiBadge>
            </div>

            <template v-if="field.secret">
              <div class="flex min-w-0 items-center gap-2">
                <div class="relative min-w-0 flex-1">
                  <UiIcon name="lock" :size="13" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                  <input
                    :id="`${idPrefix}-${field.key}`"
                    v-model="values[field.key]"
                    :type="shown.has(field.key) ? 'text' : 'password'"
                    class="input pl-8 pr-9 font-mono text-xs"
                    :class="clearing.has(field.key) ? 'line-through' : ''"
                    autocomplete="new-password"
                    spellcheck="false"
                    :placeholder="
                      plugin.secretsSet[field.key] ? t('adminTools.plugins.settings.secretKeep') : (field.placeholder ?? '')
                    "
                    :disabled="saving || clearing.has(field.key)"
                  />
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs absolute right-1 top-1/2 -translate-y-1/2"
                    :aria-label="shown.has(field.key) ? t('adminTools.plugins.settings.hide') : t('adminTools.plugins.settings.show')"
                    :title="shown.has(field.key) ? t('adminTools.plugins.settings.hide') : t('adminTools.plugins.settings.show')"
                    :disabled="clearing.has(field.key)"
                    @click="toggleShown(field.key)"
                  >
                    <UiIcon :name="shown.has(field.key) ? 'eye-off' : 'eye'" :size="13" />
                  </button>
                </div>
                <button
                  v-if="clearing.has(field.key)"
                  type="button"
                  class="btn btn-secondary btn-sm shrink-0"
                  :disabled="saving"
                  @click="undoClear(field.key)"
                >
                  <UiIcon name="rotate-ccw" :size="13" />
                  {{ t("adminTools.plugins.settings.undoClear") }}
                </button>
                <button
                  v-else-if="plugin.secretsSet[field.key]"
                  type="button"
                  class="btn btn-ghost btn-sm shrink-0 hover:!bg-danger/10 hover:!text-danger"
                  :disabled="saving"
                  @click="markClear(field.key)"
                >
                  <UiIcon name="trash" :size="13" />
                  {{ t("adminTools.plugins.settings.clear") }}
                </button>
              </div>
              <p v-if="clearing.has(field.key)" class="hint flex items-center gap-1 !text-warning">
                <UiIcon name="alert" :size="12" />
                {{ t("adminTools.plugins.settings.willClear") }}
              </p>
              <p v-else class="hint">
                <template v-if="pluginText(`fields.${field.key}.description`, field.description)">{{ pluginText(`fields.${field.key}.description`, field.description) }} · </template>{{ t("adminTools.plugins.settings.secretHint") }}
              </p>
            </template>

            <template v-else>
              <input
                :id="`${idPrefix}-${field.key}`"
                v-model="values[field.key]"
                type="text"
                class="input"
                spellcheck="false"
                autocomplete="off"
                :placeholder="field.placeholder ?? ''"
                :disabled="saving"
              />
              <p v-if="pluginText(`fields.${field.key}.description`, field.description)" class="hint">
                {{ pluginText(`fields.${field.key}.description`, field.description) }}
              </p>
            </template>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Transition
              enter-active-class="transition duration-150 ease-out"
              enter-from-class="opacity-0"
              leave-active-class="transition duration-100 ease-in"
              leave-to-class="opacity-0"
            >
              <span v-if="dirty" class="mr-auto inline-flex items-center gap-1.5 text-xs text-warning">
                <span class="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
                {{ t("adminTools.plugins.settings.dirty") }}
              </span>
            </Transition>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="!dirty || saving" @click="resetDraft()">
              {{ t("adminTools.plugins.settings.discard") }}
            </button>
            <button type="submit" class="btn btn-primary btn-sm" :disabled="!dirty || saving">
              <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
              {{ saving ? t("common.saving") : t("adminTools.plugins.settings.save") }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </article>
</template>
