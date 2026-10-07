import { invoke } from "@tauri-apps/api/core";
import type { KnowledgeRecord, RecallPoint, ReviewRecord } from "./types";

export interface RecallData {
  knowledge: KnowledgeRecord[];
  points: RecallPoint[];
  reviews: ReviewRecord[];
  browserPreview: boolean;
}

const STORAGE_KEY = "beta-life-recall-v1";

function demoData(): RecallData {
  const now = new Date().toISOString();
  const knowledge: KnowledgeRecord = {
    id: "demo-institutional-isomorphism",
    title: "制度同形化",
    markdown: "## 核心概念\n\n制度同形化描述了组织在制度环境中逐渐趋同的过程。\n\n- 强制同形化：法律、监管或资源依赖带来的压力。\n- 模仿同形化：面对不确定性时模仿成功组织。\n- 规范同形化：专业教育、职业网络和标准化训练带来的趋同。\n\n三种机制可以同时存在，但作用来源不同。",
    tags: "组织理论/制度理论/制度同形化",
    sourceNote: "演示数据：浏览器预览不会写入本地文件。",
    createdAt: now,
    updatedAt: now,
    nextReviewAt: now,
  };
  return {
    knowledge: [knowledge],
    points: [
      { pointId: "demo-point-framework", knowledgeId: knowledge.id, type: "framework", prompt: "制度同形化的三个来源是什么？", reference: "强制、模仿、规范", order: 0 },
      { pointId: "demo-point-mechanism", knowledgeId: knowledge.id, type: "mechanism", prompt: "解释模仿同形化为什么会出现。", reference: "面对不确定性时，组织模仿被认为成功的组织。", order: 1 },
      { pointId: "demo-point-relationship", knowledgeId: knowledge.id, type: "relationship", prompt: "三种同形化机制的共同点和区别是什么？", reference: "共同点是带来趋同，区别在于压力来源不同。", order: 2 },
    ],
    reviews: [],
    browserPreview: true,
  };
}

function browserData(): RecallData {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...JSON.parse(stored) as Omit<RecallData, "browserPreview">, browserPreview: true };
  } catch (error) {
    console.warn("无法读取浏览器演示数据", error);
  }
  const data = demoData();
  persistBrowser(data);
  return data;
}

function persistBrowser(data: RecallData) {
  if (!data.browserPreview) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ knowledge: data.knowledge, points: data.points, reviews: data.reviews }));
}

export function isTauriRuntime(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function loadRecallData(): Promise<RecallData> {
  if (!isTauriRuntime()) return browserData();
  const knowledge = await invoke<KnowledgeRecord[]>("list_knowledge");
  const loaded = await Promise.all(knowledge.map(async (record) => {
    const [points, reviews] = await Promise.all([
      invoke<RecallPoint[]>("load_recall_points", { knowledgeId: record.id }),
      invoke<ReviewRecord[]>("load_recall_reviews", { knowledgeId: record.id }),
    ]);
    return { record, points, reviews };
  }));
  return {
    knowledge,
    points: loaded.flatMap((item) => item.points),
    reviews: loaded.flatMap((item) => item.reviews),
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

