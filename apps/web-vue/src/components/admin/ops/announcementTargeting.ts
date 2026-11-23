import { computed, ref } from "vue";
import {
  ANNOUNCEMENT_TARGETING_MAX_CONDITIONS,
  ANNOUNCEMENT_TARGETING_MAX_GROUP_IDS,
  ANNOUNCEMENT_TARGETING_MAX_GROUPS,
  announcementUsdToNano,
  type AnnouncementBalanceOperator,
  type AnnouncementCondition,
  type AnnouncementTargeting,
  type GroupItem,
} from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { formatUsdAny, nanoToUsdInput } from "./opsUtil";

/**
 * Announcement targeting (contracts/announcements.ts) as an editable draft: OR across condition
 * groups, AND inside each group. Balance thresholds are edited as USD text and sent as nano-USD.
 */

export const TARGETING_MAX_GROUPS = ANNOUNCEMENT_TARGETING_MAX_GROUPS;
export const TARGETING_MAX_CONDITIONS = ANNOUNCEMENT_TARGETING_MAX_CONDITIONS;
export const TARGETING_MAX_GROUP_IDS = ANNOUNCEMENT_TARGETING_MAX_GROUP_IDS;

export const BALANCE_OPERATORS: AnnouncementBalanceOperator[] = ["gte", "gt", "lte", "lt", "eq"];

/** One condition row. Both shapes' fields are kept so switching the type back restores them. */
export interface DraftCondition {
  key: number;
  type: AnnouncementCondition["type"];
  groupIds: string[];
  operator: AnnouncementBalanceOperator;
  usd: string;
}

export interface DraftGroup {
  key: number;
  conditions: DraftCondition[];
}

export interface TargetingDraft {
  /** false = no extra restriction (`{ anyOf: [] }`). */
  enabled: boolean;
  groups: DraftGroup[];
}

let keySeq = 0;
const nextKey = () => ++keySeq;

export function newCondition(type: AnnouncementCondition["type"] = "subscription"): DraftCondition {
  return { key: nextKey(), type, groupIds: [], operator: "gte", usd: "" };
}

export function newGroup(): DraftGroup {
  return { key: nextKey(), conditions: [newCondition()] };
}

export function draftFromTargeting(t: AnnouncementTargeting | null | undefined): TargetingDraft {
  const anyOf = t?.anyOf ?? [];
  return {
    enabled: anyOf.length > 0,
    groups: anyOf.map((g) => ({
      key: nextKey(),
      conditions: g.allOf.map((c) =>
        c.type === "subscription"
          ? { ...newCondition("subscription"), groupIds: [...c.groupIds] }
          : { ...newCondition("balance"), operator: c.operator, usd: nanoToUsdInput(c.valueNanoUsd) },
      ),
    })),
  };
}

/** The request form; call only after `validateDraft` found nothing. */
export function targetingFromDraft(d: TargetingDraft): AnnouncementTargeting {
  if (!d.enabled) return { anyOf: [] };
  return {
    anyOf: d.groups.map((g) => ({
      allOf: g.conditions.map<AnnouncementCondition>((c) =>
        c.type === "subscription"
          ? { type: "subscription", operator: "in", groupIds: [...new Set(c.groupIds)] }
          : { type: "balance", operator: c.operator, valueNanoUsd: announcementUsdToNano(c.usd) ?? "0" },
      ),
    })),
  };
}

/** A stored rule the server could not parse comes back as an empty AND group: it matches nobody. */
export function isBrokenTargeting(t: AnnouncementTargeting | null | undefined): boolean {
  return Boolean(t?.anyOf.some((g) => g.allOf.length === 0));
}

export type ConditionIssue = "groups" | "unknownGroups" | "tooManyGroups" | "amount";

export interface DraftIssues {
  /** Custom mode without any group. */
  emptyRule: boolean;
  /** Group key → the group holds no condition. */
  emptyGroups: Set<number>;
  /** Condition key → what is wrong with it. */
  conditions: Map<number, ConditionIssue>;
  count: number;
}

/**
 * Client-side checks mirroring AnnouncementTargetingInputSchema plus the route's "existing
 * subscription group" rule. `validIds` is null while the group list is unknown (not checked).
 */
export function validateDraft(d: TargetingDraft, validIds: ReadonlySet<string> | null): DraftIssues {
  const issues: DraftIssues = { emptyRule: false, emptyGroups: new Set(), conditions: new Map(), count: 0 };
  if (!d.enabled) return issues;
  if (d.groups.length === 0) issues.emptyRule = true;
  for (const g of d.groups) {
    if (g.conditions.length === 0) issues.emptyGroups.add(g.key);
    for (const c of g.conditions) {
      let issue: ConditionIssue | null = null;
      if (c.type === "subscription") {
        if (c.groupIds.length === 0) issue = "groups";
        else if (c.groupIds.length > TARGETING_MAX_GROUP_IDS) issue = "tooManyGroups";
        else if (validIds && c.groupIds.some((id) => !validIds.has(id))) issue = "unknownGroups";
      } else if (announcementUsdToNano(c.usd) === null) {
        issue = "amount";
      }
      if (issue) issues.conditions.set(c.key, issue);
    }
  }
  issues.count = (issues.emptyRule ? 1 : 0) + issues.emptyGroups.size + issues.conditions.size;
  return issues;
}

/* ---------------- Human-readable summary ---------------- */

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * A balance threshold exactly as the server compares it, never rounded ("$10.005", "$1,000.00",
 * "-$0.50"); the display formatter would round $10.005 to $10.01.
 */
export function formatThresholdUsd(nano: string): string {
  const text = nanoToUsdInput(nano);
  if (!text) return formatUsdAny(nano);
  const neg = text.startsWith("-");
  const [whole = "0", frac = ""] = (neg ? text.slice(1) : text).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}.${frac.padEnd(2, "0")}`;
}

/** One phrase per condition, grouped like the rule: `[[a, b], [c]]` = (a AND b) OR c. */
export function describeTargeting(
  t: AnnouncementTargeting | null | undefined,
  groupName: (id: string) => string,
  tr: Translate,
): string[][] {
  return (t?.anyOf ?? []).map((g) =>
    g.allOf.map((c) =>
      c.type === "subscription"
        ? tr("annAdmin.targeting.summary.subscription", { groups: c.groupIds.map(groupName).join(tr("annAdmin.targeting.summary.groupSep")) })
        : tr("annAdmin.targeting.summary.balance", {
            op: tr(`annAdmin.targeting.ops.${c.operator}`),
            amount: formatThresholdUsd(c.valueNanoUsd),
          }),
    ),
  );
}

/** The summary as one line: "(a 且 b) 或 c". `standalone` capitalises it for use on its own. */
export function targetingSentence(parts: string[][], tr: Translate, standalone = false): string {
  const and = ` ${tr("annAdmin.targeting.and")} `;
  const or = ` ${tr("annAdmin.targeting.or")} `;
  const text = parts.map((g) => (g.length > 1 && parts.length > 1 ? `(${g.join(and)})` : g.join(and))).join(or);
  if (!standalone) return text;
  const i = text.startsWith("(") ? 1 : 0;
  return text.slice(0, i) + text.charAt(i).toLocaleUpperCase() + text.slice(i + 1);
}

/* ---------------- Subscription groups (picker + names) ---------------- */

const allGroups = ref<GroupItem[]>([]);
const groupsLoaded = ref(false);
const groupsLoading = ref(false);
const groupsFailed = ref(false);
let groupsInFlight: Promise<void> | null = null;

/**
 * Admin groups shared by the announcement page, editor and read-status drawer. Only groups with
 * `subscriptionType === "subscription"` can be targeted (the server refuses the others).
 */
export function useSubscriptionGroups() {
  function load(force = false): Promise<void> {
    if (groupsInFlight) return groupsInFlight;
    if (groupsLoaded.value && !force) return Promise.resolve();
    groupsLoading.value = true;
    groupsFailed.value = false;
    groupsInFlight = apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups")
      .then((res) => {
        allGroups.value = res.groups;
        groupsLoaded.value = true;
      })
      .catch(() => {
        groupsFailed.value = true;
      })
      .finally(() => {
        groupsLoading.value = false;
        groupsInFlight = null;
      });
    return groupsInFlight;
  }

  const subscriptionGroups = computed(() =>
    allGroups.value
      .filter((g) => g.subscriptionType === "subscription")
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );
  const byId = computed(() => new Map(allGroups.value.map((g) => [g.id, g])));
  /** Ids the server accepts in a rule; null until the list has loaded. */
  const validIds = computed<ReadonlySet<string> | null>(() =>
    groupsLoaded.value ? new Set(subscriptionGroups.value.map((g) => g.id)) : null,
  );

  return {
    subscriptionGroups,
    byId,
    validIds,
    loaded: groupsLoaded,
    loading: groupsLoading,
    failed: groupsFailed,
    load,
  };
}
