import type { TempUnschedRule } from "@slipgate/contracts";

/** Same caps as TempUnschedRulesSchema / TempUnschedRuleSchema in @slipgate/contracts. */
export const MAX_TEMP_UNSCHED_RULES = 10;
const MAX_KEYWORDS = 20;
const MAX_MINUTES = 10080;

/** Form shape of a rule: the status and keywords are typed as text. */
export interface EditableRule {
  /** "" = any HTTP error. */
  statusCode: string;
  /** Comma / newline separated. */
  keywordsText: string;
  durationMinutes: number;
  description: string;
}

export function blankRule(): EditableRule {
  return { statusCode: "", keywordsText: "", durationMinutes: 30, description: "" };
}

export function toEditable(rule: TempUnschedRule): EditableRule {
  return {
    statusCode: rule.statusCode ? String(rule.statusCode) : "",
    keywordsText: rule.keywords.join(", "),
    durationMinutes: rule.durationMinutes,
    description: rule.description,
  };
}

function keywords(text: string): string[] {
  return text
    .split(/[,\n，]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export type RuleProblem = "status" | "duration" | "keywords";

/** What makes a rule unsavable (the server would refuse it), or null. */
export function ruleProblem(rule: EditableRule): RuleProblem | null {
  if (rule.statusCode !== "") {
    const code = Number(rule.statusCode);
    if (!Number.isInteger(code) || code < 400 || code > 599) return "status";
  }
  if (!Number.isInteger(rule.durationMinutes) || rule.durationMinutes < 1 || rule.durationMinutes > MAX_MINUTES) return "duration";
  const list = keywords(rule.keywordsText);
  if (list.length > MAX_KEYWORDS || list.some((k) => k.length > 200)) return "keywords";
  return null;
}

export function toRule(rule: EditableRule): TempUnschedRule {
  return {
    statusCode: rule.statusCode === "" ? 0 : Number(rule.statusCode),
    keywords: keywords(rule.keywordsText),
    durationMinutes: rule.durationMinutes,
    description: rule.description.trim(),
  };
}

/** Order-sensitive comparison (the first matching rule wins). */
export function sameRules(a: readonly TempUnschedRule[], b: readonly TempUnschedRule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
