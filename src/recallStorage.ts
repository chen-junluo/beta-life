import { invoke } from "@tauri-apps/api/core";
import { replayReviewLog } from "./recall/fsrs";
import type { FsrsSchedulerSnapshot, KnowledgeRecord, RecallPoint, ReviewRecord } from "./types";

export interface RecallData {
  knowledge: KnowledgeRecord[];
  points: RecallPoint[];
  reviews: ReviewRecord[];
  schedulers: FsrsSchedulerSnapshot[];
  browserPreview: boolean;
}

const STORAGE_KEY = "beta-life-recall-v1";
const DEMO_SOURCE_NOTE = "演示数据 v2：30 天前创建，第 3 天、10 天、17 天和 24 天各复习一次。";

function demoData(): RecallData {
  const now = new Date();
  const isoDaysAgo = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
  const createdAt = isoDaysAgo(30);
  const knowledge: KnowledgeRecord = {
    id: "demo-institutional-isomorphism",
    title: "制度同形化",
    markdown: "## 核心概念\n\n制度同形化描述了组织在制度环境中逐渐趋同的过程。\n\n- 强制同形化：法律、监管或资源依赖带来的压力。\n- 模仿同形化：面对不确定性时模仿成功组织。\n- 规范同形化：专业教育、职业网络和标准化训练带来的趋同。\n\n三种机制可以同时存在，但作用来源不同。",
    tags: "组织理论/制度理论/制度同形化",
    sourceNote: DEMO_SOURCE_NOTE,
    createdAt,
    updatedAt: isoDaysAgo(1),
    nextReviewAt: isoDaysAgo(6),
  };
  const points: RecallPoint[] = [
      { pointId: "demo-point-framework", knowledgeId: knowledge.id, type: "framework", prompt: "制度同形化的三个来源是什么？", reference: "强制、模仿、规范", order: 0 },
      { pointId: "demo-point-mechanism", knowledgeId: knowledge.id, type: "mechanism", prompt: "解释模仿同形化为什么会出现。", reference: "面对不确定性时，组织模仿被认为成功的组织。", order: 1 },
      { pointId: "demo-point-relationship", knowledgeId: knowledge.id, type: "relationship", prompt: "三种同形化机制的共同点和区别是什么？", reference: "共同点是带来趋同，区别在于压力来源不同。", order: 2 },
  ];
  const reviews: ReviewRecord[] = [
    { reviewId: "demo-review-1", knowledgeId: knowledge.id, mode: "full", answer: "强制、模仿、规范。", status: "correct", feedback: "三个来源都回忆到了。", evidence: "强制、模仿、规范", confirmedAt: isoDaysAgo(27), nextReviewAt: isoDaysAgo(26), source: "manual", grade: "Good" },
    { reviewId: "demo-review-2", knowledgeId: knowledge.id, mode: "full", answer: "大致记得三种机制，但区别不清楚。", status: "incomplete", feedback: "框架还在，但机制区别需要再巩固。", evidence: "三种机制", confirmedAt: isoDaysAgo(20), nextReviewAt: isoDaysAgo(19), source: "manual", grade: "Hard" },
    { reviewId: "demo-review-3", knowledgeId: knowledge.id, mode: "full", answer: "三种机制都会带来趋同，来源不同。", status: "correct", feedback: "共同点和区别都回忆到了。", evidence: "带来趋同，来源不同", confirmedAt: isoDaysAgo(13), nextReviewAt: isoDaysAgo(12), source: "manual", grade: "Good" },
    { reviewId: "demo-review-4", knowledgeId: knowledge.id, mode: "full", answer: "把强制和规范的来源混在了一起。", status: "wrong", feedback: "来源方向记错了，需要重新回忆。", evidence: "来源混淆", confirmedAt: isoDaysAgo(6), nextReviewAt: isoDaysAgo(5), source: "manual", grade: "Again" },
  ];
  const scheduler = replayReviewLog(knowledge.id, points.map((point) => point.pointId), reviews, { createdAt: new Date(createdAt), now }).snapshot;
  return {
    knowledge: [knowledge],
    points,
    reviews,
    schedulers: [scheduler],
    browserPreview: true,
  };
}

function browserData(): RecallData {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<RecallData>;
      if (parsed.knowledge?.length === 1 && parsed.knowledge[0]?.id === "demo-institutional-isomorphism" && parsed.knowledge[0]?.sourceNote !== DEMO_SOURCE_NOTE) {
        const seeded = demoData();
        persistBrowser(seeded);
        return seeded;
      }
      return { ...parsed as Omit<RecallData, "browserPreview">, schedulers: parsed.schedulers ?? [], browserPreview: true };
    }
  } catch (error) {
    console.warn("无法读取浏览器演示数据", error);
  }
  const data = demoData();
  persistBrowser(data);
  return data;
}

function persistBrowser(data: RecallData) {
  if (!data.browserPreview) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ knowledge: data.knowledge, points: data.points, reviews: data.reviews, schedulers: data.schedulers }));
}

export function isTauriRuntime(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

async function seedTauriDemo(): Promise<RecallData> {
  const seed = demoData();
  for (const record of seed.knowledge) await saveKnowledge({ ...record, nextReviewAt: undefined });
  for (const record of seed.knowledge) await saveRecallPoints(record.id, seed.points.filter((point) => point.knowledgeId === record.id));
  for (const review of seed.reviews) await appendReview(review);
  for (const scheduler of seed.schedulers) await saveRecallScheduler(scheduler);
  return { ...seed, browserPreview: false };
}

export async function loadRecallData(): Promise<RecallData> {
  if (!isTauriRuntime()) return browserData();
  const knowledge = await invoke<KnowledgeRecord[]>("list_knowledge");
  const staleDemo = knowledge.length === 1 && knowledge[0].id === "demo-institutional-isomorphism" && knowledge[0].sourceNote !== DEMO_SOURCE_NOTE;
  if (knowledge.length === 0) {
    return seedTauriDemo();
  }
  if (staleDemo) {
    await deleteKnowledge(knowledge[0].id);
    return seedTauriDemo();
  }
  const loaded = await Promise.all(knowledge.map(async (record) => {
    const [points, reviews, scheduler] = await Promise.all([
      invoke<RecallPoint[]>("load_recall_points", { knowledgeId: record.id }),
      invoke<ReviewRecord[]>("load_recall_reviews", { knowledgeId: record.id }),
      invoke<FsrsSchedulerSnapshot | null>("load_recall_scheduler", { knowledgeId: record.id }),
    ]);
    return { record, points, reviews, scheduler };
  }));
  const schedulers = loaded.map((item) => item.scheduler).filter((item): item is FsrsSchedulerSnapshot => Boolean(item));
  return {
    knowledge,
    points: loaded.flatMap((item) => item.points),
    reviews: loaded.flatMap((item) => item.reviews),
    schedulers,
    browserPreview: false,
  };
}

export async function saveKnowledge(knowledge: KnowledgeRecord): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("save_knowledge", { knowledge });
    return;
  }
  const data = browserData();
  const index = data.knowledge.findIndex((item) => item.id === knowledge.id);
  if (index >= 0) data.knowledge[index] = knowledge;
  else data.knowledge.unshift(knowledge);
  persistBrowser(data);
}

export async function deleteKnowledge(knowledgeId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_knowledge", { knowledgeId });
    return;
  }
  const data = browserData();
  data.knowledge = data.knowledge.filter((item) => item.id !== knowledgeId);
  data.points = data.points.filter((item) => item.knowledgeId !== knowledgeId);
  data.reviews = data.reviews.filter((item) => item.knowledgeId !== knowledgeId);
  data.schedulers = data.schedulers.filter((item) => item.knowledgeId !== knowledgeId);
  persistBrowser(data);
}

export async function saveRecallPoints(knowledgeId: string, points: RecallPoint[]): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("save_recall_points", { knowledgeId, points });
    return;
  }
  const data = browserData();
  data.points = [...data.points.filter((item) => item.knowledgeId !== knowledgeId), ...points];
  persistBrowser(data);
}

export async function appendReview(review: ReviewRecord): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("append_recall_review", { review });
    return;
  }
  const data = browserData();
  data.reviews.push(review);
  const knowledge = data.knowledge.find((item) => item.id === review.knowledgeId);
  if (knowledge) knowledge.nextReviewAt = review.nextReviewAt;
  persistBrowser(data);
}

export async function deleteRecallReview(knowledgeId: string, reviewId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_recall_review", { knowledgeId, reviewId });
    return;
  }
  const data = browserData();
  const originalCount = data.reviews.length;
  data.reviews = data.reviews.filter((review) => !(review.knowledgeId === knowledgeId && review.reviewId === reviewId));
  if (data.reviews.length === originalCount) throw new Error("找不到这条历史结果，可能已经被删除。");
  persistBrowser(data);
}

export async function loadRecallScheduler(knowledgeId: string): Promise<FsrsSchedulerSnapshot | undefined> {
  if (isTauriRuntime()) return (await invoke<FsrsSchedulerSnapshot | null>("load_recall_scheduler", { knowledgeId })) ?? undefined;
  return browserData().schedulers.find((item) => item.knowledgeId === knowledgeId);
}

export async function saveRecallScheduler(snapshot: FsrsSchedulerSnapshot): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("save_recall_scheduler", { snapshot });
    return;
  }
  const data = browserData();
  data.schedulers = [...data.schedulers.filter((item) => item.knowledgeId !== snapshot.knowledgeId), snapshot];
  persistBrowser(data);
}
