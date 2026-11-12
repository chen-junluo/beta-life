import type { ActivityCategory, RuleTarget } from "../activity";
import { DEFAULT_PET_SETTINGS } from "../defaults";
import type { PetSettings } from "../types";

/** Rust `categories::Pulse`, polled by bebe every tick. */
export interface ActivityPulse {
  /** The main window is focused: bubbles wait until the user leaves beta-life. */
  inBetaLife: boolean;
  /** What is in front; `null` while away. `target` is `null` when a title keyword decided. */
  current: { label: string; category: ActivityCategory | null; target: RuleTarget | null } | null;
  recentSlackMs: number;
  /** Start of the slack streak still going on. */
  slackSince: number | null;
  /** Unclassified apps / sites used at least `askAfterMs` today, longest first. */
  candidates: Array<RuleTarget & { todayMs: number }>;
}

const MINUTE = 60_000;
/** Between two "what is this?" questions. */
export const ASK_GAP_MS = 5 * MINUTE;

/** The slack reminder thresholds from Settings → bebe, in milliseconds. */
export interface SlackRules {
  /** Slack must fill more than `share` of the last `windowMs`… */
  windowMs: number;
  share: number;
  /** …and the current streak must be this long. */
  streakMs: number;
  /** No second slack reminder sooner than this. */
  cooldownMs: number;
  /** 「X 分钟后再说」. */
  snoozeMs: number;
}

export function slackRules(pet: PetSettings): SlackRules {
  return {
    windowMs: pet.slackWindowMinutes * MINUTE,
    share: pet.slackSharePercent / 100,
    streakMs: pet.slackStreakMinutes * MINUTE,
    cooldownMs: pet.slackCooldownMinutes * MINUTE,
    snoozeMs: pet.slackSnoozeMinutes * MINUTE,
  };
}

export const DEFAULT_SLACK_RULES = slackRules(DEFAULT_PET_SETTINGS);

/** Rust `categories::PulseRequest`. */
export const pulseRequest = (windowMs: number) => ({ windowMs, askAfterMs: 3 * MINUTE });

export type NudgeLevel = 1 | 2 | 3;

export interface NudgeMemory {
  /** No reminder before this. */
  quietUntil: number;
  /** When the last reminder was shown; a streak that started before it is the same episode. */
  nudgedAt: number | null;
  level: number;
}

export const FRESH_NUDGES: NudgeMemory = { quietUntil: 0, nudgedAt: null, level: 0 };

function sameEpisode(pulse: ActivityPulse, memory: NudgeMemory): boolean {
  return pulse.slackSince !== null && memory.nudgedAt !== null && pulse.slackSince <= memory.nudgedAt;
}

/**
 * The reminder to show now, if any: by default more than 60% of the last 10 minutes on slack and
 * a streak of at least 5 minutes, at most every 30 minutes. Within one episode each reminder is one
 * level stronger (light bubble → bubble with actions → worried bebe); a new episode starts at 1.
 */
export function nudgeLevel(pulse: ActivityPulse, memory: NudgeMemory, now: number, rules = DEFAULT_SLACK_RULES): NudgeLevel | null {
  if (pulse.inBetaLife || !pulse.current || pulse.slackSince === null) return null;
  if (now < memory.quietUntil || now - pulse.slackSince < rules.streakMs) return null;
  if (pulse.recentSlackMs <= rules.share * rules.windowMs) return null;
  return sameEpisode(pulse, memory) ? (Math.min(memory.level + 1, 3) as NudgeLevel) : 1;
}

export function afterNudge(level: NudgeLevel, now: number, rules = DEFAULT_SLACK_RULES): NudgeMemory {
  return { quietUntil: now + rules.cooldownMs, nudgedAt: now, level };
}

/** bebe looks worried while the episode that reached level 3 goes on. */
export function isWorried(pulse: ActivityPulse | null, memory: NudgeMemory): boolean {
  return Boolean(pulse && memory.level >= 3 && sameEpisode(pulse, memory));
}

export function targetKey(target: RuleTarget): string {
  return `${target.kind}:${target.key}`;
}

/** The unclassified app / site to ask about now, skipping the ones dismissed today. */
export function askCandidate(pulse: ActivityPulse, skipped: string[]): (RuleTarget & { todayMs: number }) | null {
  if (pulse.inBetaLife || !pulse.current) return null;
  return pulse.candidates.find((candidate) => !skipped.includes(targetKey(candidate))) ?? null;
}

export function nudgeText(level: NudgeLevel, label: string, minutes: number): string {
  if (level === 1) return `在 ${label} 待了 ${minutes} 分钟啦，汪！要不要回去做事？`;
  if (level === 2) return `${label} 已经 ${minutes} 分钟了。先回去做 5 分钟正事？`;
  return `汪……${label} 已经 ${minutes} 分钟了，bebe 有点担心。回去做一小步就好。`;
}
