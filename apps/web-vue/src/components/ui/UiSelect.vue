<script lang="ts">
import {
  Comment,
  Fragment,
  Static,
  Teleport,
  Text,
  Transition,
  defineComponent,
  h,
  isVNode,
  nextTick,
  normalizeClass,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
  type PropType,
  type VNode,
  type VNodeArrayChildren,
} from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "./UiIcon.vue";

/**
 * Drop-in replacement for a native `<select>`: write the same `<option>` / `<optgroup>` children
 * (v-for, v-if and static options all work) and bind `v-model` (or `:model-value` +
 * `@update:model-value`). The popup is a themed listbox teleported to `<body>` so dialogs and
 * scroll containers never clip it; it flips above the trigger when there is no room below.
 *
 * - Keyboard: ArrowUp/Down, Home/End, PageUp/Down, Enter/Space to pick, Escape to close (without
 *   closing a surrounding dialog), typeahead on the trigger, Tab closes.
 * - Long lists (> 12 options, or `searchable`) get a filter box.
 * - `@change` receives the new value (not an Event) and fires only when the value changes.
 * - Values compare like Vue's `v-model` on `<select>`: primitives match by their string form.
 * - `required` keeps native form validation via a visually hidden input.
 */

interface ParsedOption {
  value: unknown;
  label: string;
  disabled: boolean;
  /** `<option hidden>`: never listed, but still labels the trigger when selected (placeholder). */
  hidden: boolean;
  group: string | null;
}

const SEARCH_THRESHOLD = 12;
const MAX_PANEL_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;
const GAP = 4;
/** Hidden width sizers mimic a native select's widest-option width; capped for huge lists. */
const MAX_SIZERS = 200;

let uid = 0;
/** Only one list is open at a time, even when a click arrives without a pointerdown (assistive tech). */
let closeOpenSelect: (() => void) | null = null;

function attrOn(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

/** Vue's `looseEqual` for the primitives a `<select>` carries. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}

function textOf(children: unknown): string {
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map((c) => (isVNode(c) ? textOf(c.children) : textOf(c))).join("");
  return "";
}

/** Static (stringified) option markup from the template compiler. */
function collectStatic(html: string, group: string | null, out: ParsedOption[]) {
  const host = document.createElement("select");
  host.innerHTML = html;
  for (const o of Array.from(host.querySelectorAll("option"))) {
    const parent = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement : null;
    out.push({
      value: o.value,
      label: o.label || o.textContent?.trim() || "",
      disabled: o.disabled || Boolean(parent?.disabled),
      hidden: o.hidden,
      group: parent ? parent.label : group,
    });
  }
}

function collect(nodes: VNodeArrayChildren, group: string | null, groupDisabled: boolean, out: ParsedOption[]) {
  for (const node of nodes) {
    if (Array.isArray(node)) {
      collect(node, group, groupDisabled, out);
      continue;
    }
    if (!isVNode(node)) continue;
    const vnode = node as VNode;
    if (vnode.type === Comment || vnode.type === Text) continue;
    if (vnode.type === Fragment) {
      if (Array.isArray(vnode.children)) collect(vnode.children, group, groupDisabled, out);
      continue;
    }
    if (vnode.type === Static) {
      collectStatic(String(vnode.children ?? ""), group, out);
      continue;
    }
    const props = (vnode.props ?? {}) as Record<string, unknown>;
    if (vnode.type === "optgroup") {
      if (Array.isArray(vnode.children)) {
        collect(vnode.children, String(props.label ?? ""), groupDisabled || attrOn(props.disabled), out);
      }
      continue;
    }
    if (vnode.type === "option") {
      const label = textOf(vnode.children).trim() || String(props.label ?? "");
      out.push({
        value: "value" in props ? props.value : label,
        label,
        disabled: groupDisabled || attrOn(props.disabled),
        hidden: attrOn(props.hidden),
        group,
      });
    }
  }
}

export default defineComponent({
  name: "UiSelect",
  inheritAttrs: false,
  props: {
    modelValue: { type: null as unknown as PropType<unknown>, required: false },
    /** Set by `v-model.number` / `.trim`; Vue applies them when emitting. */
    modelModifiers: { type: Object as PropType<Record<string, boolean>>, default: undefined },
    disabled: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    /** Trigger text while nothing (or an unknown value) is selected. */
    placeholder: { type: String, default: "" },
    /** Filter box; defaults to on for lists longer than 12 options. */
    searchable: { type: Boolean, default: undefined },
    /** Built-in chevron; turn off when the caller draws its own indicator. */
    chevron: { type: Boolean, default: true },
    /** Extra classes for the popup panel (e.g. a fixed width). */
    menuClass: { type: String, default: "" },
  },
  emits: ["update:modelValue", "change"],
  setup(props, { attrs, slots, emit, expose }) {
    const { t } = useI18n();
    const id = `ui-select-${++uid}`;
    const open = ref(false);
    const query = ref("");
    const activeIndex = ref(-1);
    const triggerRef = ref<HTMLButtonElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    const listRef = ref<HTMLElement | null>(null);
    const searchRef = ref<HTMLInputElement | null>(null);
    // `bottom` anchors a flipped panel to the trigger's top edge (no transform: the menu transition owns it).
    const pos = reactive({ top: 0, bottom: 0, left: 0, minWidth: 0, maxHeight: MAX_PANEL_HEIGHT, above: false });

    // Refreshed on every render; event handlers read the latest list.
    let options: ParsedOption[] = [];
    let listed: ParsedOption[] = [];
    let typeBuffer = "";
    let typeTimer: number | undefined;

    const isSearchable = () => props.searchable ?? options.filter((o) => !o.hidden).length > SEARCH_THRESHOLD;
    const isSmall = () => /\b(input-sm|text-xs)\b/.test(normalizeClass(attrs.class));
    const selectedOption = () => options.find((o) => sameValue(o.value, props.modelValue)) ?? null;

    function filter(list: ParsedOption[]): ParsedOption[] {
      const q = query.value.trim().toLowerCase();
      if (!q) return list;
      return list.filter((o) => o.label.toLowerCase().includes(q) || (o.group ?? "").toLowerCase().includes(q));
    }

    function firstEnabled(from = 0, step = 1): number {
      for (let i = from; i >= 0 && i < listed.length; i += step) {
        if (!listed[i]!.disabled) return i;
      }
      return -1;
    }

    function scrollActiveIntoView() {
      void nextTick(() => {
        listRef.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
      });
    }

    function setActive(index: number) {
      if (index < 0 || index >= listed.length) return;
      activeIndex.value = index;
      scrollActiveIntoView();
    }

    function move(delta: number) {
      if (!listed.length) return;
      const step = delta > 0 ? 1 : -1;
      let i = activeIndex.value < 0 ? (step > 0 ? -1 : listed.length) : activeIndex.value;
      let remaining = Math.abs(delta);
      let last = activeIndex.value;
      while (remaining > 0) {
        i += step;
        if (i < 0 || i >= listed.length) break;
        if (!listed[i]!.disabled) {
          last = i;
          remaining -= 1;
        }
      }
      if (last >= 0) setActive(last);
    }

    function place() {
      const el = triggerRef.value;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      // The trigger scrolled out of view: a floating list would point at nothing.
      if (r.bottom < 0 || r.top > vh) {
        close(false);
        return;
      }
      const below = vh - r.bottom - VIEWPORT_MARGIN - GAP;
      const above = r.top - VIEWPORT_MARGIN - GAP;
      const panelHeight = panelRef.value?.scrollHeight ?? MAX_PANEL_HEIGHT;
      pos.above = below < Math.min(panelHeight, 200) && above > below;
      pos.maxHeight = Math.max(120, Math.min(MAX_PANEL_HEIGHT, pos.above ? above : below));
      pos.minWidth = r.width;
      const width = Math.max(panelRef.value?.offsetWidth ?? r.width, r.width);
      pos.left = Math.max(VIEWPORT_MARGIN, Math.min(r.left, vw - VIEWPORT_MARGIN - width));
      pos.top = r.bottom + GAP;
      pos.bottom = vh - r.top + GAP;
    }

    function onWindowChange() {
      if (open.value) place();
    }

    function onDocPointerDown(ev: PointerEvent) {
      const target = ev.target as Node | null;
      if (!target) return;
      if (triggerRef.value?.contains(target) || panelRef.value?.contains(target)) return;
      close(false);
    }

    function listen(on: boolean) {
      const method = on ? "addEventListener" : "removeEventListener";
      window[method]("scroll", onWindowChange, true);
      window[method]("resize", onWindowChange);
      document[method]("pointerdown", onDocPointerDown as EventListener, true);
    }

    async function openMenu(seed = "") {
      if (props.disabled || open.value) return;
      query.value = seed && isSearchable() ? seed : "";
      closeOpenSelect?.();
      closeOpenSelect = () => close(false);
      open.value = true;
      listen(true);
      await nextTick();
      const selectedAt = listed.findIndex((o) => sameValue(o.value, props.modelValue));
      activeIndex.value = selectedAt >= 0 && !listed[selectedAt]!.disabled ? selectedAt : firstEnabled();
      place();
      // Measure again once the panel has its real size (flip / clamp to the viewport).
      await nextTick();
      place();
      scrollActiveIntoView();
      if (searchRef.value) searchRef.value.focus({ preventScroll: true });
      else if (seed) typeahead(seed);
    }

    function close(refocus = true) {
      if (!open.value) return;
      open.value = false;
      closeOpenSelect = null;
      query.value = "";
      listen(false);
      if (refocus) triggerRef.value?.focus({ preventScroll: true });
    }

    function choose(option: ParsedOption | undefined) {
      if (!option || option.disabled) return;
      const changed = !sameValue(option.value, props.modelValue);
      close(true);
      if (!changed) return;
      emit("update:modelValue", option.value);
      emit("change", option.value);
    }

    function typeahead(char: string) {
      window.clearTimeout(typeTimer);
      typeBuffer += char.toLowerCase();
      typeTimer = window.setTimeout(() => (typeBuffer = ""), 600);
      // Repeating one letter cycles through the options starting with it.
      const repeat = typeBuffer.length > 1 && [...typeBuffer].every((c) => c === typeBuffer[0]);
      const needle = repeat ? typeBuffer[0]! : typeBuffer;
      const start = repeat || typeBuffer.length === 1 ? activeIndex.value + 1 : Math.max(activeIndex.value, 0);
      for (let n = 0; n < listed.length; n++) {
        const i = (start + n) % listed.length;
        const o = listed[i]!;
        if (!o.disabled && o.label.toLowerCase().startsWith(needle)) {
          setActive(i);
          return;
        }
      }
    }

    function onTriggerKeydown(ev: KeyboardEvent) {
      if (!open.value) {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(ev.key)) {
          ev.preventDefault();
          void openMenu();
        } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          ev.preventDefault();
          void openMenu(ev.key);
        }
        return;
      }
      if (ev.key === " ") {
        ev.preventDefault();
        if (typeBuffer) typeahead(" ");
        else choose(listed[activeIndex.value]);
        return;
      }
      if (navigate(ev)) return;
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) typeahead(ev.key);
    }

    /** Keys shared by the trigger and the filter box; true when handled. */
    function navigate(ev: KeyboardEvent): boolean {
      const inSearch = ev.target === searchRef.value;
      switch (ev.key) {
        case "ArrowDown":
          move(1);
          break;
        case "ArrowUp":
          move(-1);
          break;
        case "PageDown":
          move(8);
          break;
        case "PageUp":
          move(-8);
          break;
        case "Home":
          if (inSearch) return false;
          setActive(firstEnabled());
          break;
        case "End":
          if (inSearch) return false;
          setActive(firstEnabled(listed.length - 1, -1));
          break;
        case "Enter":
          choose(listed[activeIndex.value]);
          break;
        case "Escape":
          // Keep a surrounding dialog / drawer (document-level Escape) open.
          ev.stopPropagation();
          close(true);
          break;
        case "Tab":
          if (!inSearch) {
            close(false);
            return true;
          }
          close(true);
          break;
        default:
          return false;
      }
      ev.preventDefault();
      return true;
    }

    watch(query, () => {
      void nextTick(() => {
        activeIndex.value = firstEnabled();
        place();
      });
    });
    watch(
      () => props.disabled,
      (disabled) => {
        if (disabled) close(false);
      },
    );
    onBeforeUnmount(() => {
      close(false);
      listen(false);
      window.clearTimeout(typeTimer);
    });

    expose({ focus: () => triggerRef.value?.focus(), close: () => close(false) });

    function renderOptions() {
      if (!listed.length) {
        return [h("li", { class: "px-2.5 py-2 text-xs text-fg-subtle", role: "presentation" }, t("common.selectNoMatch"))];
      }
      const small = isSmall();
      const items: VNode[] = [];
      let lastGroup: string | null = null;
      listed.forEach((option, index) => {
        if (option.group !== lastGroup) {
          lastGroup = option.group;
          if (option.group) {
            items.push(
              h(
                "li",
                { key: `g-${index}`, role: "presentation", class: "eyebrow px-2.5 pb-1 pt-2 first:pt-1" },
                option.group,
              ),
            );
          }
        }
        const selected = sameValue(option.value, props.modelValue);
        const active = index === activeIndex.value;
        items.push(
          h(
            "li",
            {
              key: `o-${index}`,
              id: `${id}-opt-${index}`,
              role: "option",
              "aria-selected": String(selected),
              "aria-disabled": option.disabled ? "true" : undefined,
              "data-active": active ? "true" : undefined,
              class: [
                "ui-select-option",
                small ? "py-1.5 text-xs" : "py-2 text-sm",
                selected ? "font-medium text-fg" : "text-fg-muted",
                active && !option.disabled ? "bg-surface-2 text-fg" : "",
                option.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              ],
              onMousemove: () => {
                if (!option.disabled && activeIndex.value !== index) activeIndex.value = index;
              },
              onClick: () => choose(option),
            },
            [
              h("span", { class: "min-w-0 flex-1 truncate" }, option.label),
              selected ? h(UiIcon, { name: "check", size: small ? 12 : 14, class: "shrink-0 text-accent" }) : null,
            ],
          ),
        );
      });
      return items;
    }

    return () => {
      options = [];
      collect(slots.default?.() ?? [], null, false, options);
      const visible = options.filter((o) => !o.hidden);
      listed = filter(visible);
      const selected = selectedOption();
      const label = selected?.label ?? props.placeholder;
      const small = isSmall();
      const { class: cls, style, ...rest } = attrs;

      const trigger = h(
        "button",
        {
          ...rest,
          ref: triggerRef,
          type: "button",
          // Callers pass the usual `select` / `input-sm` classes; `select-trigger` adapts them to a button.
          class: ["select-trigger", cls],
          style,
          disabled: props.disabled,
          role: "combobox",
          "aria-haspopup": "listbox",
          "aria-expanded": String(open.value),
          "aria-controls": `${id}-list`,
          "aria-activedescendant":
            open.value && activeIndex.value >= 0 && !isSearchable() ? `${id}-opt-${activeIndex.value}` : undefined,
          onClick: () => (open.value ? close(true) : void openMenu()),
          onKeydown: onTriggerKeydown,
        },
        [
          // Hidden sizers make an auto-width trigger as wide as its longest option, like <select>.
          h("span", { class: "grid min-w-0 flex-1" }, [
            h(
              "span",
              { class: ["col-start-1 row-start-1 truncate", selected && !selected.disabled ? "" : "text-fg-subtle"] },
              label || " ",
            ),
            ...visible
              .slice(0, MAX_SIZERS)
              .map((o, i) =>
                h("span", { key: i, class: "invisible col-start-1 row-start-1 h-0 truncate", "aria-hidden": "true" }, o.label),
              ),
          ]),
          props.chevron
            ? h(UiIcon, {
                name: "chevron-down",
                size: small ? 13 : 15,
                class: ["select-chevron", open.value ? "rotate-180 text-accent" : ""],
              })
            : null,
        ],
      );

      // Like a native required <select>, an empty value (or a placeholder option) is invalid.
      const empty = !selected || props.modelValue === "" || props.modelValue === null || props.modelValue === undefined;
      const validity = props.required
        ? h("input", {
            class: "sr-only",
            tabindex: -1,
            "aria-hidden": "true",
            required: true,
            value: empty ? "" : "1",
            onFocus: () => triggerRef.value?.focus(),
          })
        : null;

      const panel = h(Teleport, { to: "body" }, [
        h(
          Transition,
          { name: "menu" },
          {
            default: () =>
              open.value
                ? h(
                    "div",
                    {
                      ref: panelRef,
                      class: [
                        "menu-panel ui-select-panel fixed z-[55] flex flex-col",
                        pos.above ? "origin-bottom" : "origin-top",
                        props.menuClass,
                      ],
                      style: {
                        left: `${pos.left}px`,
                        ...(pos.above ? { bottom: `${pos.bottom}px` } : { top: `${pos.top}px` }),
                        minWidth: `${pos.minWidth}px`,
                        maxHeight: `${pos.maxHeight}px`,
                      },
                      // Keep focus on the trigger (or the filter box) while picking with the mouse.
                      onMousedown: (ev: MouseEvent) => {
                        if (ev.target !== searchRef.value) ev.preventDefault();
                      },
                    },
                    [
                      isSearchable()
                        ? h("div", { class: "relative shrink-0 p-1 pb-1.5" }, [
                            h(UiIcon, {
                              name: "search",
                              size: 13,
                              class: "pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle",
                            }),
                            h("input", {
                              ref: searchRef,
                              type: "text",
                              value: query.value,
                              class: "input input-sm pl-8",
                              placeholder: t("common.selectSearch"),
                              autocomplete: "off",
                              spellcheck: "false",
                              role: "searchbox",
                              "aria-controls": `${id}-list`,
                              "aria-activedescendant": activeIndex.value >= 0 ? `${id}-opt-${activeIndex.value}` : undefined,
                              onInput: (ev: Event) => (query.value = (ev.target as HTMLInputElement).value),
                              onKeydown: (ev: KeyboardEvent) => navigate(ev),
                            }),
                          ])
                        : null,
                      h(
                        "ul",
                        {
                          ref: listRef,
                          id: `${id}-list`,
                          role: "listbox",
                          "aria-label": typeof attrs["aria-label"] === "string" ? attrs["aria-label"] : undefined,
                          class: "min-h-0 flex-1 overflow-y-auto overscroll-contain",
                        },
                        renderOptions(),
                      ),
                    ],
                  )
                : null,
          },
        ),
      ]);

      return [trigger, validity, panel];
    };
  },
});
</script>
