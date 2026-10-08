import { describe, expect, it } from "vitest";
import { createSchedulerSnapshot, applyGrade, buildCurve, buildKnowledgeCurve, gradeForStatus, mergeReviewsByKnowledgeDay, replayReviewLog, retrievability, emptyCardSnapshot } from ".";
import type { ReviewRecord } from "../../types";

const pointId = "point-1";
const knowledgeId = "knowledge-1";

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId: crypto.randomUUID(),
    knowledgeId,
    pointId,
    mode: "point",
    answer: "answer",
    status: "correct",
    feedback: "ok",
    evidence: "",
    confirmedAt: "2026-01-01T00:00:00.000Z",
    nextReviewAt: "2026-01-02T00:00:00.000Z",
    source: "manual",
    ...overrides,
  };
}

describe("FSRS adapter", () => {
  it("keeps the documented feedback-to-grade defaults", () => {
    expect(gradeForStatus("wrong")).toBe("Again");
    expect(gradeForStatus("omitted")).toBe("Again");
    expect(gradeForStatus("incomplete")).toBe("Hard");
    expect(gradeForStatus("misunderstood")).toBe("Hard");
    expect(gradeForStatus("correct")).toBe("Good");
  });

  it("matches ts-fsrs fixed-date output for a new Good card", () => {
    const snapshot = createSchedulerSnapshot(knowledgeId, [pointId], new Date("2026-01-01T00:00:00.000Z"));
    const result = applyGrade(snapshot.cards[pointId], "Good", new Date("2026-01-01T00:00:00.000Z"), snapshot.parameters);
    expect(result.card.stability).toBe(2.3065);
    expect(result.card.state).toBe("Learning");
    expect(result.due).toBe("2026-01-01T00:10:00.000Z");
  });

  it("uses the continuous FSRS forgetting curve between review days", () => {
    const first = review({ reviewId: "fractional", confirmedAt: "2026-01-01T00:00:00.000Z", grade: "Good" });
    const snapshot = replayReviewLog(knowledgeId, [pointId], [first], { now: new Date("2026-01-04T00:00:00.000Z") }).snapshot;
    const stability = snapshot.cards[pointId].stability;
    const curve = buildCurve(pointId, [first], snapshot, {
      startAt: new Date("2026-01-01T00:00:00.000Z"),
      now: new Date(new Date("2026-01-01T00:00:00.000Z").getTime() + stability * 86400000),
      days: stability,
      step: stability,
    });
    expect(curve.at(-1)?.model).toBeCloseTo(0.9, 4);
  });

  it("replays confirmed logs deterministically and ignores duplicate IDs", () => {
    const first = review({ reviewId: "r1", grade: "Good" });
    const duplicate = { ...first, confirmedAt: "2026-01-02T00:00:00.000Z" };
    const replayed = replayReviewLog(knowledgeId, [pointId], [first, duplicate], { now: new Date("2026-01-03T00:00:00.000Z") });
    expect(replayed.migratedReviewIds).toEqual([]);
    expect(replayed.skippedReviewIds).toEqual(["r1"]);
    expect(replayed.snapshot.cards[pointId].reps).toBe(1);
  });

  it("keeps reference, model, and observations on one day axis", () => {
    const first = review({ reviewId: "r1", grade: "Good" });
    const snapshot = replayReviewLog(knowledgeId, [pointId], [first], { now: new Date("2026-01-03T00:00:00.000Z") }).snapshot;
    const curve = buildCurve(pointId, [first], snapshot, { now: new Date("2026-01-03T00:00:00.000Z"), days: 3, step: 1 });
    expect(curve.map((item) => item.day)).toEqual([0, 0, 1, 2, 3]);
    expect(curve.some((item) => item.observation?.reviewId === "r1")).toBe(true);
    expect(curve.find((item) => item.observation)?.observation?.value).toBe(1);
    expect(curve.every((item) => item.reference >= 0 && item.reference <= 1)).toBe(true);
  });

  it("does not invent retrievability for an unreviewed card", () => {
    expect(retrievability(emptyCardSnapshot(new Date("2026-01-01T00:00:00.000Z")), new Date("2026-01-02T00:00:00.000Z"))).toBe(0);
  });

  it("aggregates checkpoint events into one knowledge-level curve", () => {
    const secondPoint = "point-2";
    const first = review({ reviewId: "r1", confirmedAt: "2026-01-01T00:00:00.000Z", grade: "Good" });
    const second = review({ reviewId: "r2", pointId: secondPoint, confirmedAt: "2026-01-03T00:00:00.000Z", grade: "Again", status: "wrong" });
    const snapshot = replayReviewLog(knowledgeId, [pointId, secondPoint], [first, second], { now: new Date("2026-01-04T00:00:00.000Z") }).snapshot;
    const curve = buildKnowledgeCurve(knowledgeId, [pointId, secondPoint], [first, second], snapshot, { now: new Date("2026-01-04T00:00:00.000Z"), startAt: new Date("2026-01-01T00:00:00.000Z"), days: 3, step: 1 });
    expect(curve).toHaveLength(6);
    expect(curve.some((item) => item.observation?.grade === "Again")).toBe(true);
    expect(curve.filter((item) => item.observation).length).toBe(2);
    expect(curve[3].model).not.toBeCloseTo(curve[1].model, 3);
  });

  it("collapses checkpoint results from one review session into one observed point", () => {
    const secondPoint = "point-2";
    const first = review({ reviewId: "r1", confirmedAt: "2026-01-01T00:00:00.000Z", grade: "Good" });
    const second = review({ reviewId: "r2", pointId: secondPoint, confirmedAt: "2026-01-01T00:00:00.000Z", grade: "Again", status: "wrong" });
    const snapshot = replayReviewLog(knowledgeId, [pointId, secondPoint], [first, second]).snapshot;
    const curve = buildKnowledgeCurve(knowledgeId, [pointId, secondPoint], [first, second], snapshot, { now: new Date("2026-01-02T00:00:00.000Z"), startAt: new Date("2026-01-01T00:00:00.000Z"), days: 1, step: 1 });
    expect(curve.filter((item) => item.observation).length).toBe(1);
    expect(curve.find((item) => item.observation)?.observation?.value).toBe(1);
  });

  it("keeps one best result per knowledge and natural day", () => {
    const again = review({ reviewId: "again", confirmedAt: "2026-01-02T02:00:00.000Z", grade: "Again", status: "wrong" });
    const good = review({ reviewId: "good", confirmedAt: "2026-01-02T10:00:00.000Z", grade: "Good", status: "correct" });
    const events = mergeReviewsByKnowledgeDay(knowledgeId, [pointId], [again, good]);
    expect(events).toHaveLength(1);
    expect(events[0].reviewId).toBe("good");
    expect(events[0].rawReviewIds).toEqual(["again", "good"]);
    const replayed = replayReviewLog(knowledgeId, [pointId], [again, good]).snapshot;
    expect(replayed.cards[pointId].stability).toBe(2.3065);
  });

  it("shows a reference and model baseline even before the first review", () => {
    const curve = buildKnowledgeCurve(knowledgeId, [pointId], [], undefined, { startAt: new Date("2026-01-01T00:00:00.000Z"), now: new Date("2026-01-03T00:00:00.000Z"), days: 2, step: 1 });
    expect(curve).toHaveLength(3);
    expect(curve[0].reference).toBe(1);
    expect(curve[0].model).toBe(1);
    expect(curve[2].reference).toBeLessThan(curve[0].reference);
  });

  it("anchors a clipped reference curve to createdAt rather than resetting it to 100%", () => {
    const curve = buildKnowledgeCurve(knowledgeId, [pointId], [], undefined, {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startAt: new Date("2026-01-08T00:00:00.000Z"),
      now: new Date("2026-01-10T00:00:00.000Z"),
      days: 2,
      step: 1,
    });
    expect(curve[0].reference).toBeLessThan(1);
    expect(curve[0].model).toBe(curve[0].reference);
  });

  it("replays a full-knowledge review across all checkpoint cards", () => {
    const full = review({ reviewId: "full", pointId: undefined, grade: "Again", status: "wrong" });
    const replayed = replayReviewLog(knowledgeId, [pointId, "point-2"], [full]).snapshot;
    expect(replayed.cards[pointId].reps).toBe(1);
    expect(replayed.cards["point-2"].reps).toBe(1);
  });
});
