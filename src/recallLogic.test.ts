import { describe, expect, it } from "vitest";
import { buildTagTree, chooseCandidate, matchesTag, statusHint } from "./recallLogic";
import type { KnowledgeRecord, ReviewRecord } from "./types";

function note(id: string, tags: string, nextReviewAt?: string): KnowledgeRecord {
  return { id, title: id, markdown: "正文", tags, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", nextReviewAt };
}

describe("recall tag filtering", () => {
  it("matches a selected parent and builds nested paths", () => {
    const records = [note("a", "组织理论/制度理论/制度同形化"), note("b", "心理学/记忆")];
    expect(matchesTag(records[0], "组织理论")).toBe(true);
    expect(matchesTag(records[1], "组织理论")).toBe(false);
    const organization = buildTagTree(records).find((node) => node.path === "组织理论");
    expect(organization?.children[0].path).toBe("组织理论/制度理论");
  });
});

describe("recall selection", () => {
  it("prioritizes due weak feedback over a stronger due item", () => {
    const reviews = new Map<string, ReviewRecord>([
      ["strong", { reviewId: "1", knowledgeId: "strong", mode: "framework", answer: "", status: "incomplete", feedback: "", evidence: "", confirmedAt: "2026-01-02T00:00:00Z", nextReviewAt: "2026-01-03T00:00:00Z", source: "manual" }],
      ["weak", { reviewId: "2", knowledgeId: "weak", mode: "framework", answer: "", status: "wrong", feedback: "", evidence: "", confirmedAt: "2026-01-03T00:00:00Z", nextReviewAt: "2026-01-03T00:00:00Z", source: "manual" }],
    ]);
    const result = chooseCandidate([
      { knowledge: note("strong", "a", "2026-01-03T00:00:00Z"), lastReview: reviews.get("strong") },
      { knowledge: note("weak", "a", "2026-01-03T00:00:00Z"), lastReview: reviews.get("weak") },
    ], { now: new Date("2026-01-04T00:00:00Z") });
    expect(result.candidate?.knowledge.id).toBe("weak");
    expect(result.reason).toContain("到期");
  });

  it("uses a uniform index for random mode", () => {
    const records = [note("a", "x"), note("b", "x"), note("c", "x")];
    expect(chooseCandidate(records.map((knowledge) => ({ knowledge })), { random: true, randomValue: 0 }).candidate?.knowledge.id).toBe("a");
    expect(chooseCandidate(records.map((knowledge) => ({ knowledge })), { random: true, randomValue: 0.99 }).candidate?.knowledge.id).toBe("c");
  });

  it("randomizes the full pool when nothing is due", () => {
    const records = [note("a", "x", "2026-02-01T00:00:00Z"), note("b", "x", "2026-02-01T00:00:00Z")];
    const result = chooseCandidate(records.map((knowledge) => ({ knowledge })), { now: new Date("2026-01-01T00:00:00Z"), randomValue: 0.99 });
    expect(result.candidate?.knowledge.id).toBe("b");
    expect(result.reason).toContain("均匀随机");
  });
});

it("provides accessible status hints", () => {
  expect(statusHint("omitted")).toContain("遗漏");
  expect(statusHint("wrong", "作用方向记反了")).toBe("作用方向记反了");
});
