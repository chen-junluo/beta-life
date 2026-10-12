import type { FsrsCardSnapshot, KnowledgeRecord, RecallPoint, RecallStatus, ReviewRecord } from "./types";

export interface TagTreeNode {
  path: string;
  label: string;
  depth: number;
  children: TagTreeNode[];
}

export function normalizeTags(value: string): string[] {
  return value
    .split(/[\n,，;；]+/)
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index);
}

export function matchesTag(record: KnowledgeRecord, selected: string): boolean {
  if (!selected) return true;
  return normalizeTags(record.tags).some((tag) => tag === selected || tag.startsWith(`${selected}/`));
}

export function buildTagTree(records: KnowledgeRecord[]): TagTreeNode[] {
  const paths = new Set<string>();
  records.forEach((record) => normalizeTags(record.tags).forEach((tag) => {
    const parts = tag.split("/");
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
  }));
  const nodes = [...paths].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const root: TagTreeNode = { path: "", label: "", depth: -1, children: [] };
  nodes.forEach((path) => {
    const parts = path.split("/");
    let siblings = root.children;
    parts.forEach((label, index) => {
      const currentPath = parts.slice(0, index + 1).join("/");
      let node = siblings.find((item) => item.path === currentPath);
      if (!node) {
        node = { path: currentPath, label, depth: index, children: [] };
        siblings.push(node);
        siblings.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
      }
      siblings = node.children;
    });
  });
  return root.children;
}

export function flattenTagTree(nodes: TagTreeNode[]): TagTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTagTree(node.children)]);
}

export interface SelectionCandidate {
  knowledge: KnowledgeRecord;
  point?: RecallPoint;
  lastReview?: ReviewRecord;
  schedulerCard?: FsrsCardSnapshot;
  currentRetrievability?: number;
}

function weakRank(status?: ReviewRecord["status"]): number {
  if (status === "Again" || status === "wrong" || status === "omitted") return 0;
  if (status === "Hard" || status === "misunderstood" || status === "incomplete") return 1;
  if (status === "Good" || status === "correct") return 4;
  if (status === "Easy") return 5;
  return 3;
}

function isDue(knowledge: KnowledgeRecord, now: Date): boolean {
  return !knowledge.nextReviewAt || new Date(knowledge.nextReviewAt).getTime() <= now.getTime();
}

export const DEFAULT_SELECTION_WEIGHTS = {
  dueBoost: 100,
  weaknessBoost: 12,
  overdueBoostPerDay: 2,
  randomJitter: 0.25,
};

function schedulerDue(candidate: SelectionCandidate, now: Date, targetRetention: number): boolean {
  if (candidate.currentRetrievability !== undefined) return candidate.currentRetrievability <= targetRetention;
  return Boolean(candidate.schedulerCard && new Date(candidate.schedulerCard.due).getTime() <= now.getTime());
}

function schedulerWeakness(candidate: SelectionCandidate): number {
  const status = candidate.lastReview?.status;
  const statusScore = status === "Again" || status === "wrong" || status === "omitted"
    ? 4
    : status === "Hard" || status === "misunderstood" || status === "incomplete"
      ? 2
      : status === "Good" || status === "Easy" || status === "correct"
        ? 0
        : 1;
  const r = candidate.schedulerCard && candidate.schedulerCard.stability > 0 && candidate.schedulerCard.lastReview
    ? Math.max(0, 1 - Math.min(1, Math.max(0, candidate.schedulerCard.lastRetrievability)))
    : 1;
  return statusScore + r;
}

export function selectionPriority(
  candidate: SelectionCandidate,
  now: Date,
  randomValue = 0,
  weights = DEFAULT_SELECTION_WEIGHTS,
  targetRetention = 0.9,
): number {
  const due = schedulerDue(candidate, now, targetRetention) || isDue(candidate.knowledge, now);
  const dueAt = candidate.schedulerCard?.due ?? candidate.knowledge.nextReviewAt;
  const overdueDays = dueAt && due ? Math.max(0, (now.getTime() - new Date(dueAt).getTime()) / 86400000) : 0;
  return (due ? weights.dueBoost : 0) + schedulerWeakness(candidate) * weights.weaknessBoost + overdueDays * weights.overdueBoostPerDay + randomValue * weights.randomJitter;
}

export function chooseCandidate(
  candidates: SelectionCandidate[],
  options: { random?: boolean; now?: Date; randomValue?: number; targetRetention?: number } = {},
): { candidate?: SelectionCandidate; reason: string } {
  if (candidates.length === 0) return { reason: "当前筛选范围没有可抽查内容" };
  const now = options.now ?? new Date();
  const targetRetention = options.targetRetention ?? 0.9;
  const hasScheduler = candidates.some((item) => item.schedulerCard);
  if (hasScheduler) {
    const due = candidates.filter((item) => schedulerDue(item, now, targetRetention));
    if (due.length > 0) {
      const value = Math.min(0.999999, Math.max(0, options.randomValue ?? Math.random()));
      return { candidate: due[Math.floor(value * due.length)], reason: "优先选择达到目标触发线的项目，再在其中均匀随机" };
    }
    if (options.random) {
      const value = Math.min(0.999999, Math.max(0, options.randomValue ?? Math.random()));
      return { candidate: candidates[Math.floor(value * candidates.length)], reason: "没有达到目标触发线的项目，当前标签范围内均匀随机" };
    }
    const ranked = candidates.map((candidate, index) => ({ candidate, score: selectionPriority(candidate, now, (options.randomValue ?? Math.random()) + index * 0.000001, DEFAULT_SELECTION_WEIGHTS, targetRetention) })).sort((a, b) => b.score - a.score);
    return {
      candidate: ranked[0]?.candidate,
      reason: "没有达到目标触发线的项目，选择当前最需要复习的考点",
    };
  }
  if (options.random) {
    const value = Math.min(0.999999, Math.max(0, options.randomValue ?? Math.random()));
    return { candidate: candidates[Math.floor(value * candidates.length)], reason: "当前标签范围内均匀随机" };
  }
  const due = candidates.filter((item) => isDue(item.knowledge, now));
  if (due.length === 0) {
    const value = Math.min(0.999999, Math.max(0, options.randomValue ?? Math.random()));
    return { candidate: candidates[Math.floor(value * candidates.length)], reason: "没有到期项目，当前范围内均匀随机" };
  }
  const pool = due;
  const sorted = [...pool].sort((a, b) => {
    const weak = weakRank(a.lastReview?.status) - weakRank(b.lastReview?.status);
    if (weak !== 0) return weak;
    const aTime = a.lastReview ? new Date(a.lastReview.confirmedAt).getTime() : 0;
    const bTime = b.lastReview ? new Date(b.lastReview.confirmedAt).getTime() : 0;
    return aTime - bTime;
  });
  return {
    candidate: sorted[0],
    reason: "优先到期项目，再按最近反馈较弱",
  };
}

export function pointsForKnowledge(points: RecallPoint[], knowledgeId: string): RecallPoint[] {
  return points
    .filter((point) => point.knowledgeId === knowledgeId)
    .sort((a, b) => a.order - b.order);
}

export function statusLabel(status: RecallStatus): string {
  return status;
}

export function statusHint(status: RecallStatus, feedback?: string): string {
  if (feedback?.trim()) return feedback.trim();
  return {
    Again: "核心内容未能回忆出来，需要重新复习。",
    Hard: "回忆有困难，或仍缺少重要内容。",
    Good: "核心内容回忆准确且覆盖充分。",
    Easy: "内容准确完整，并且回忆轻松。",
  }[status];
}
