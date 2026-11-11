import { describe, expect, it } from "vitest";
import { afterNudge, askCandidate, COOLDOWN_MS, FRESH_NUDGES, isWorried, nudgeLevel, targetKey, type ActivityPulse } from "./slack";

const MIN = 60_000;
const now = 1_000 * MIN;
const pulse = (patch: Partial<ActivityPulse> = {}): ActivityPulse => ({
  inBetaLife: false,
  current: { label: "bilibili.com", category: "slack", target: { kind: "domain", key: "bilibili.com", label: "bilibili.com" } },
  recentSlackMs: 8 * MIN,
  slackSince: now - 6 * MIN,
  candidates: [],
  ...patch,
});

describe("slack reminders", () => {
  it("needs both a high share of slack and a 5-minute streak", () => {
    expect(nudgeLevel(pulse(), FRESH_NUDGES, now)).toBe(1);
    expect(nudgeLevel(pulse({ recentSlackMs: 6 * MIN }), FRESH_NUDGES, now)).toBeNull();
    expect(nudgeLevel(pulse({ slackSince: now - 4 * MIN }), FRESH_NUDGES, now)).toBeNull();
    expect(nudgeLevel(pulse({ slackSince: null }), FRESH_NUDGES, now)).toBeNull();
  });

  it("waits while the user is in beta-life or away", () => {
    expect(nudgeLevel(pulse({ inBetaLife: true }), FRESH_NUDGES, now)).toBeNull();
    expect(nudgeLevel(pulse({ current: null }), FRESH_NUDGES, now)).toBeNull();
  });

  it("escalates within one episode after the cooldown and starts over in a new one", () => {
    let memory = afterNudge(1, now);
    const later = now + COOLDOWN_MS;
    expect(nudgeLevel(pulse(), memory, later - 1)).toBeNull();
    expect(nudgeLevel(pulse(), memory, later)).toBe(2);
    memory = afterNudge(2, later);
    expect(nudgeLevel(pulse(), memory, later + COOLDOWN_MS)).toBe(3);
    memory = afterNudge(3, later + COOLDOWN_MS);
    expect(nudgeLevel(pulse(), memory, later + 2 * COOLDOWN_MS)).toBe(3);
    expect(isWorried(pulse(), memory)).toBe(true);
    // Back to work, then a new streak: bebe calms down and the next reminder is light again.
    expect(isWorried(pulse({ slackSince: null }), memory)).toBe(false);
    const fresh = pulse({ slackSince: later + 2 * COOLDOWN_MS });
    expect(isWorried(fresh, memory)).toBe(false);
    expect(nudgeLevel(fresh, memory, later + 2 * COOLDOWN_MS + 6 * MIN)).toBe(1);
  });

  it("asks about one unclassified target at a time, skipping today's dismissed ones", () => {
    const candidates = [
      { kind: "domain" as const, key: "ycombinator.com", label: "ycombinator.com", todayMs: 9 * MIN },
      { kind: "app" as const, key: "notion.id", label: "Notion", todayMs: 4 * MIN },
    ];
    expect(askCandidate(pulse({ candidates }), [])?.key).toBe("ycombinator.com");
    expect(askCandidate(pulse({ candidates }), [targetKey(candidates[0])])?.key).toBe("notion.id");
    expect(askCandidate(pulse({ candidates, inBetaLife: true }), [])).toBeNull();
    expect(askCandidate(pulse({ candidates: [] }), [])).toBeNull();
  });
});
