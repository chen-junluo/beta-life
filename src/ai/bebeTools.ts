import { invoke } from "@tauri-apps/api/core";
import { CATEGORIES, dayKey, setActivityRule, type ActivityCategory, type ActivityDay, type ActivityRules, type RuleTarget } from "../activity";
import { loadPetPlan, planCancel, planReminder, planSnooze, savePetPlan, undoPlan, type PlanUndo } from "../pet/plan";
import { quietHoursText, WEEKDAYS } from "../pet/reminders";
import type { PetSettings, QuietHours } from "../types";
import type { AiChange, ChangeKind, InstantAction, ToolArguments } from "./types";

/** `bebe/偏好.md` (Rust `bebe::Profile`). */
export interface PetProfile {
  style: string[];
  about: string[];
}
export type ProfileSection = keyof PetProfile;
export const PROFILE_SECTIONS: Record<ProfileSection, { label: string; help: string }> = {
  style: { label: "说话风格", help: "每次对话都会带上，dock、工作台和 bebe 都按这里说话" },
  about: { label: "我说过的", help: "你让 bebe 记住的事，AI 回答和安排时会参考" },
};
export const loadPetProfile = () => invoke<PetProfile>("load_pet_profile");
export const savePetProfile = (profile: PetProfile) => invoke<PetProfile>("save_pet_profile", { profile });

type Display = { kind: ChangeKind; title: string; detail: string };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------- instant: bebe's plan ----------

/** snooze / schedule_reminder / cancel_reminder: saved right away; the chat offers an undo. */
export async function runInstant(name: string, args: ToolArguments, now = Date.now()): Promise<InstantAction> {
  const plan = await loadPetPlan();
  const step = name === "snooze"
    ? planSnooze(plan, args, now)
    : name === "schedule_reminder"
      ? planReminder(plan, args, now, crypto.randomUUID().slice(0, 8))
      : planCancel(plan, args, now);
  await savePetPlan(step.plan);
  return { label: step.label, undo: step.undo };
}

export async function undoInstant(undo: PlanUndo): Promise<void> {
  await savePetPlan(undoPlan(await loadPetPlan(), undo));
}

// ---------- staged: settings ----------

type NumberKey = Exclude<keyof PetSettings, "quietHours">;
export const PET_NUMBER_FIELDS: Array<{ key: NumberKey; label: string; unit: string; min: number; max: number }> = [
  { key: "slackWindowMinutes", label: "摸鱼统计窗口", unit: "分钟", min: 3, max: 60 },
  { key: "slackSharePercent", label: "摸鱼占比超过", unit: "%", min: 10, max: 100 },
  { key: "slackStreakMinutes", label: "连续摸鱼至少", unit: "分钟", min: 1, max: 120 },
  { key: "slackCooldownMinutes", label: "两次摸鱼提醒至少隔", unit: "分钟", min: 1, max: 240 },
  { key: "slackSnoozeMinutes", label: "摸鱼提醒「再说」", unit: "分钟", min: 1, max: 240 },
  { key: "summaryLeadMinutes", label: "晚间总结提前", unit: "分钟", min: 5, max: 180 },
  { key: "habitSnoozeMinutes", label: "习惯「稍后提醒」", unit: "分钟", min: 1, max: 240 },
  { key: "habitLowPercent", label: "习惯完成率低于", unit: "%", min: 1, max: 100 },
];
const withUnit = (value: number, unit: string) => (unit === "%" ? `${value}%` : `${value} ${unit}`);

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function quietHoursProblem(quiet: QuietHours): string | null {
  if (quiet.days.length === 0 || new Set(quiet.days).size !== quiet.days.length) return "每段安静时段至少选一天";
  if (!CLOCK.test(quiet.start) || !CLOCK.test(quiet.end)) return "安静时段的时间格式应为 HH:MM";
  if (quiet.start === quiet.end) return "安静时段的开始和结束不能相同";
  return null;
}

/** set_bebe_settings: only the fields given change; quietHours replaces the list. */
export function applyPetSettings(pet: PetSettings, args: ToolArguments): PetSettings {
  const next = { ...pet };
  for (const field of PET_NUMBER_FIELDS) {
    if (args[field.key] !== undefined) next[field.key] = Number(args[field.key]);
  }
  if (args.quietHours !== undefined) {
    const quietHours = args.quietHours as QuietHours[];
    for (const quiet of quietHours) {
      const problem = quietHoursProblem(quiet);
      if (problem) throw new Error(`quietHours: ${problem}`);
    }
    next.quietHours = quietHours.map((quiet) => ({ ...quiet, days: WEEKDAYS.map((day) => day.id).filter((day) => quiet.days.includes(day)) }));
  }
  return next;
}

const quietList = (list: QuietHours[]) => (list.length ? list.map(quietHoursText).join("；") : "无");

export function describePetSettings(before: PetSettings, after: PetSettings): Display {
  const parts = PET_NUMBER_FIELDS
    .filter((field) => before[field.key] !== after[field.key])
    .map((field) => `${field.label} ${withUnit(before[field.key], field.unit)} → ${withUnit(after[field.key], field.unit)}`);
  if (quietList(before.quietHours) !== quietList(after.quietHours)) parts.push(`安静时段 ${quietList(before.quietHours)} → ${quietList(after.quietHours)}`);
  if (parts.length === 0) throw new Error("Nothing changes: bebe already has these settings");
  return { kind: "edit", title: "bebe 设置", detail: parts.join("；") };
}

// ---------- staged: preferences ----------

export function applyPreference(profile: PetProfile, name: string, args: ToolArguments): PetProfile {
  const section = args.section as ProfileSection;
  const text = String(args.text ?? "").trim();
  const list = profile[section];
  if (name === "remember_preference") {
    if (list.includes(text)) throw new Error("This is already remembered");
    return { ...profile, [section]: [...list, text] };
  }
  if (!list.includes(text)) throw new Error(`No remembered item "${text}" under ${section}; quote it exactly as listed`);
  return { ...profile, [section]: list.filter((item) => item !== text) };
}

export function describePreference(name: string, args: ToolArguments): Display {
  const remember = name === "remember_preference";
  return { kind: remember ? "add" : "del", title: String(args.text ?? "").trim(), detail: `${remember ? "记住" : "忘掉"} · ${PROFILE_SECTIONS[args.section as ProfileSection].label}` };
}

// ---------- staged: classification ----------

const KIND_LABELS: Record<string, string> = { app: "应用", site: "网站", keyword: "标题关键词" };
const categoryOf = (value: unknown): ActivityCategory | null => (value === "none" ? null : (value as ActivityCategory));
const categoryLabel = (category: ActivityCategory | null) => CATEGORIES.find((item) => item.id === category)?.label ?? "待分类";

/** The rule an app or site classification edits; an app is found by the name the timeline shows. */
export async function classifyTarget(args: ToolArguments): Promise<RuleTarget> {
  const name = String(args.name ?? "").trim();
  if (args.kind === "site") return { kind: "domain", key: name, label: name };
  const lower = name.toLowerCase();
  const rules = await invoke<ActivityRules>("load_activity_rules");
  const rule = rules.apps.find((item) => item.name.toLowerCase() === lower || item.key.toLowerCase() === lower);
  if (rule) return { kind: "app", key: rule.key, label: rule.name };
  const day = await invoke<ActivityDay>("load_activity_day", { date: dayKey(new Date()) });
  const today = Object.entries(day.apps).find(([app]) => app.toLowerCase() === lower)?.[1];
  if (today?.kind === "app") return { kind: "app", key: today.key, label: today.label };
  throw new Error(`No app named "${name}" in the rules or today's timeline; use the app name the timeline shows`);
}

export function describeClassify(args: ToolArguments): Display {
  return { kind: "edit", title: String(args.name ?? ""), detail: `${KIND_LABELS[String(args.kind)]} → ${categoryLabel(categoryOf(args.category))}` };
}

async function applyClassification(args: ToolArguments): Promise<void> {
  const category = categoryOf(args.category);
  if (args.kind === "keyword") {
    const keyword = String(args.name ?? "").trim();
    const rules = await invoke<ActivityRules>("load_activity_rules");
    const keywords = rules.keywords.filter((rule) => rule.keyword.toLowerCase() !== keyword.toLowerCase());
    await invoke("save_activity_rules", { rules: { ...rules, keywords: category ? [...keywords, { keyword, category }] : keywords } });
    return;
  }
  // Staging resolved the target; changes saved without it are resolved again.
  const target: RuleTarget = typeof args.key === "string" && (args.targetKind === "app" || args.targetKind === "domain")
    ? { kind: args.targetKind, key: args.key, label: String(args.label ?? args.key) }
    : await classifyTarget(args);
  await setActivityRule(target, category);
}

// ---------- commit ----------

export interface BebeCommitTargets {
  getPet: () => PetSettings | null;
  savePet: (pet: PetSettings) => void;
}

/** Replays confirmed bebe changes on the current settings, profile and rules. */
export async function commitBebeChanges(changes: AiChange[], targets: BebeCommitTargets): Promise<Array<{ changeId: string; reason: string }>> {
  const failed = new Map<string, string>();
  const fail = (change: AiChange, error: unknown) => failed.set(change.id, message(error));

  const settings = changes.filter((change) => change.name === "set_bebe_settings");
  const start = targets.getPet();
  if (settings.length > 0 && !start) settings.forEach((change) => fail(change, "App state is not loaded"));
  if (settings.length > 0 && start) {
    let pet = start;
    for (const change of settings) {
      try {
        pet = applyPetSettings(pet, change.arguments);
      } catch (error) {
        fail(change, error);
      }
    }
    if (pet !== start) targets.savePet(pet);
  }

  const preferences = changes.filter((change) => change.name === "remember_preference" || change.name === "forget_preference");
  if (preferences.length > 0) {
    try {
      const before = await loadPetProfile();
      let profile = before;
      for (const change of preferences) {
        try {
          profile = applyPreference(profile, change.name, change.arguments);
        } catch (error) {
          fail(change, error);
        }
      }
      if (profile !== before) await savePetProfile(profile);
    } catch (error) {
      preferences.filter((change) => !failed.has(change.id)).forEach((change) => fail(change, error));
    }
  }

  for (const change of changes.filter((item) => item.name === "classify_activity")) {
    try {
      await applyClassification(change.arguments);
    } catch (error) {
      fail(change, error);
    }
  }
  return [...failed].map(([changeId, reason]) => ({ changeId, reason }));
}
