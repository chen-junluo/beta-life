import type { KnowledgeRecord, RecallPoint, RecallStatus, ReviewRecord } from "./types";

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
}

function weakRank(status?: RecallStatus): number {
  if (status === "wrong") return 0;
  if (status === "misunderstood") return 1;
  if (status === "incomplete") return 2;
  if (status === "omitted") return 3;
  if (status === "correct") return 5;
  return 4;
}

function isDue(knowledge: KnowledgeRecord, now: Date): boolean {
  return !knowledge.nextReviewAt || new Date(knowledge.nextReviewAt).getTime() <= now.getTime();
}

export function chooseCandidate(
  candidates: SelectionCandidate[],
  options: { random?: boolean; now?: Date; randomValue?: number } = {},
): { candidate?: SelectionCandidate; reason: string } {
  if (candidates.length === 0) return { reason: "当前筛选范围没有可抽查内容" };
  if (options.random) {
    const value = Math.min(0.999999, Math.max(0, options.randomValue ?? Math.random()));
    return { candidate: candidates[Math.floor(value * candidates.length)], reason: "当前标签范围内均匀随机" };
  }
  const now = options.now ?? new Date();
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
  return {
    wrong: "记错",
    omitted: "遗漏",
    incomplete: "不完整",
    misunderstood: "理解偏差",
    correct: "正确",
  }[status];
}

export function statusHint(status: RecallStatus, feedback?: string): string {
  if (feedback?.trim()) return feedback.trim();
  return {
    wrong: "这里的作用方向记反了。",
    omitted: "答案遗漏了这个考点。",
    incomplete: "提到了概念，但少了关键条件。",
    misunderstood: "概念提到了，但关系理解有偏差。",
    correct: "关键点覆盖完整。",
  }[status];
}
