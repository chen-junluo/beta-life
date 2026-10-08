// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { deleteRecallReview, loadRecallData } from "./recallStorage";

describe("recall review storage", () => {
  beforeEach(() => localStorage.clear());

  it("removes one confirmed result from browser preview history", async () => {
    const before = await loadRecallData();
    const target = before.reviews[0];
    expect(target).toBeDefined();

    await deleteRecallReview(target.knowledgeId, target.reviewId);

    const after = await loadRecallData();
    expect(after.reviews).toHaveLength(before.reviews.length - 1);
    expect(after.reviews.some((review) => review.reviewId === target.reviewId)).toBe(false);
    expect(after.reviews.every((review) => review.knowledgeId === target.knowledgeId)).toBe(true);
  });
});
