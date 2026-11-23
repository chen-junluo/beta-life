import { describe, expect, it } from "vitest";
import { appendUnderHeading, applyProposals, pendingTurn, scoreTrend, splitId, withEvaluation, withQuestion } from "./socialLogic";
import type { SocialVersion } from "./types";

const version: SocialVersion = {
  id: "进度询问261111",
  question: "这学期进展怎么样？",
  topic: "进度询问",
  starred: false,
  status: "open",
  context: "",
  turns: [
    { question: "这学期进展怎么样？", answer: "A 已投", score: null },
    { question: "B 呢？", answer: "", score: null },
  ],
  evaluation: "",
};

describe("socialLogic", () => {
  it("finds the turn waiting for an answer", () => {
    expect(pendingTurn(version.turns)).toBe(1);
    expect(pendingTurn(version.turns.slice(0, 1))).toBeNull();
  });

  it("does not treat a blank question as waiting for an answer", () => {
    expect(pendingTurn([{ question: "", answer: "", score: null }])).toBeNull();
    expect(pendingTurn([{ question: "问？", answer: "", score: null }])).toBe(0);
  });

  it("fills a blank first question instead of appending a turn", () => {
    const blank = [{ question: "", answer: "", score: null }];
    expect(withQuestion(blank, "这学期进展怎么样？")).toEqual([{ question: "这学期进展怎么样？", answer: "", score: null }]);
    const asked = [{ question: "A？", answer: "", score: null }];
    expect(withQuestion(asked, "B？")).toEqual([{ question: "A？", answer: "", score: null }, { question: "B？", answer: "", score: null }]);
    expect(withQuestion([], "首个问题？")).toEqual([{ question: "首个问题？", answer: "", score: null }]);
  });

  it("reads the tag off a version id", () => {
    expect(splitId("进度询问261111")).toEqual({ tag: "进度询问", suffix: "261111" });
    expect(splitId("进度询问261111-2")).toEqual({ tag: "进度询问", suffix: "261111-2" });
    expect(splitId("261111")).toEqual({ tag: "", suffix: "261111" });
    expect(splitId("没有日期")).toEqual({ tag: "没有日期", suffix: "" });
  });

  it("shows the score trend of scored versions only", () => {
    const versions = [6, null, 7, 8].map((average, index) => ({ id: `v${index}`, date: "261111", starred: false, status: "done" as const, average }));
    expect(scoreTrend({ question: "q", topic: "t", versions })).toBe("6 → 7 → 8");
  });

  it("appends inside a section and keeps the next section", () => {
    const text = "## 原则\n- 先给结论\n\n## 正样本\nQ：旧\nA：旧\n";
    expect(appendUnderHeading(text, "## 原则", "- 认一句")).toBe("## 原则\n- 先给结论\n- 认一句\n\n## 正样本\nQ：旧\nA：旧\n");
    expect(appendUnderHeading(text, "## 正样本", "Q：新\nA：新")).toBe("## 原则\n- 先给结论\n\n## 正样本\nQ：旧\nA：旧\nQ：新\nA：新\n");
    expect(appendUnderHeading("", "## 性格", "- 爱追问")).toBe("## 性格\n- 爱追问\n");
  });

  it("writes samples with their source version", () => {
    const text = applyProposals("## 原则\n\n## 正样本\n", [{ kind: "sample", text: "Q：问\nA：答" }, { kind: "principle", text: "先给事实" }], "进度询问261111");
    expect(text).toBe("## 原则\n- 先给事实\n\n## 正样本\nQ：问\nA：答\n- 来源：[[进度询问261111]]\n");
  });

  it("puts evaluation scores on answered turns only and marks the version done", () => {
    const next = withEvaluation(version, { scores: [{ score: 8, comment: "好" }], directions: ["先给事实"], proposals: [] });
    expect(next.turns[0].score).toEqual({ score: 8, comment: "好" });
    expect(next.turns[1].score).toBeNull();
    expect(next.evaluation).toBe("- 先给事实");
    expect(next.status).toBe("done");
  });
});
