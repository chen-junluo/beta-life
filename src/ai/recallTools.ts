import { invoke } from "@tauri-apps/api/core";
import { normalizeTags } from "../recallLogic";
import { restoreKnowledgeBundle, type KnowledgeBundle } from "../recallStorage";
import type { KnowledgeRecord, RecallPoint, ReviewRecord } from "../types";
import type { AiChange, ChangeKind } from "./types";

type ChangeInput = Pick<AiChange, "name" | "arguments" | "createdId">;
type Failure = { changeId: string; reason: string };

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const tagPath = (value: string) => normalizeTags(value).join("/");

function findRecord(records: KnowledgeRecord[], id: unknown): KnowledgeRecord {
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error(`No knowledge record with id "${String(id)}"`);
  return record;
}

export function recallIndex(records: KnowledgeRecord[]) {
  return {
    knowledge: records.map((record) => ({
      id: record.id,
      title: record.title,
      ...(record.tags && { tags: record.tags }),
      ...(record.nextReviewAt && { nextReviewAt: record.nextReviewAt }),
    })),
  };
}

export function dueRecords(records: KnowledgeRecord[], now = new Date()): KnowledgeRecord[] {
  return records.filter((record) => !record.nextReviewAt || new Date(record.nextReviewAt).getTime() <= now.getTime());
}

/** Applies one recall write to the record list; points and reviews are untouched. */
export function applyRecallChange(records: KnowledgeRecord[], change: ChangeInput, now = new Date().toISOString()): KnowledgeRecord[] {
  const args = change.arguments;
  switch (change.name) {
    case "add_knowledge": {
      if (!change.createdId) throw new Error("add_knowledge needs an id");
      const record: KnowledgeRecord = {
        id: change.createdId,
        title: String(args.title).trim(),
        markdown: String(args.markdown),
        tags: tagPath(text(args.tags) ?? ""),
        ...(text(args.sourceUrl)?.trim() && { sourceUrl: text(args.sourceUrl)!.trim() }),
        ...(text(args.sourceNote)?.trim() && { sourceNote: text(args.sourceNote)!.trim() }),
        createdAt: now,
        updatedAt: now,
      };
      return [record, ...records];
    }
    case "update_knowledge": {
      const record = findRecord(records, args.id);
      const fields = ["title", "markdown", "tags", "sourceUrl", "sourceNote"].filter((field) => args[field] !== undefined);
      if (fields.length === 0) throw new Error("Nothing to update");
      const next: KnowledgeRecord = {
        ...record,
        ...(text(args.title) !== undefined && { title: text(args.title)!.trim() }),
        ...(text(args.markdown) !== undefined && { markdown: text(args.markdown)! }),
        ...(text(args.tags) !== undefined && { tags: tagPath(text(args.tags)!) }),
        ...(text(args.sourceUrl) !== undefined && { sourceUrl: text(args.sourceUrl)!.trim() }),
        ...(text(args.sourceNote) !== undefined && { sourceNote: text(args.sourceNote)!.trim() }),
        updatedAt: now,
      };
      return records.map((item) => (item.id === record.id ? next : item));
    }
    case "delete_knowledge": {
      const record = findRecord(records, args.id);
      return records.filter((item) => item.id !== record.id);
    }
    default:
      throw new Error(`Unknown recall tool ${change.name}`);
  }
}

export function describeRecallChange(records: KnowledgeRecord[], change: ChangeInput): { kind: ChangeKind; title: string; detail: string } {
  const args = change.arguments;
  switch (change.name) {
    case "add_knowledge":
      return { kind: "add", title: String(args.title).trim(), detail: tagPath(text(args.tags) ?? "") || "未分类" };
    case "update_knowledge": {
      const record = findRecord(records, args.id);
      const parts = [
        text(args.title) !== undefined && text(args.title)!.trim() !== record.title && `标题 → ${text(args.title)!.trim()}`,
        text(args.tags) !== undefined && `标签 → ${tagPath(text(args.tags)!) || "（清空）"}`,
        text(args.markdown) !== undefined && "正文已修改",
        (text(args.sourceUrl) !== undefined || text(args.sourceNote) !== undefined) && "来源已修改",
      ].filter(Boolean);
      return { kind: "edit", title: record.title, detail: parts.join(" · ") || "内容不变" };
    }
    case "delete_knowledge": {
      const record = findRecord(records, args.id);
      return { kind: "del", title: record.title, detail: "连同抽查点和复习记录" };
    }
    default:
      throw new Error(`Unknown recall tool ${change.name}`);
  }
}

export async function loadKnowledge(): Promise<KnowledgeRecord[]> {
  return invoke<KnowledgeRecord[]>("list_knowledge");
}

export async function loadPoints(id: string): Promise<RecallPoint[]> {
  return invoke<RecallPoint[]>("load_recall_points", { knowledgeId: id });
}

async function loadBundle(id: string, record: KnowledgeRecord | null): Promise<KnowledgeBundle> {
  if (!record) return { id, record: null, points: [], reviews: [] };
  const [points, reviews] = await Promise.all([loadPoints(id), invoke<ReviewRecord[]>("load_recall_reviews", { knowledgeId: id })]);
  return { id, record, points, reviews };
}

/**
 * Replays confirmed recall changes on the records currently on disk and writes the result.
 * Returns before/after bundles of every touched record so the batch is one undo step.
 */
export async function commitRecallChanges(changes: AiChange[]) {
  const current = await loadKnowledge();
  let records = current;
  const failed: Failure[] = [];
  for (const change of changes) {
    try {
      records = applyRecallChange(records, change);
    } catch (error) {
      failed.push({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const ids = [...new Set([...current, ...records].map((record) => record.id))].filter(
    (id) => current.find((record) => record.id === id) !== records.find((record) => record.id === id),
  );
  const before = await Promise.all(ids.map((id) => loadBundle(id, current.find((record) => record.id === id) ?? null)));
  const after = before.map((bundle): KnowledgeBundle => {
    const record = records.find((item) => item.id === bundle.id) ?? null;
    return record ? { ...bundle, record } : { id: bundle.id, record: null, points: [], reviews: [] };
  });
  for (const bundle of after) await restoreKnowledgeBundle(bundle);
  return { before, after, failed };
}
