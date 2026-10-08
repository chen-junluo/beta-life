import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, FileText, Pencil, Plus, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseSimpleMarkdown } from "../simpleMarkdown";
import { appendReview, deleteKnowledge, deleteRecallReview, loadRecallData, saveKnowledge, saveRecallPoints, saveRecallScheduler } from "../recallStorage";
import { buildTagTree, chooseCandidate, matchesTag, normalizeTags, pointsForKnowledge, statusHint, statusLabel } from "../recallLogic";
import { applyGrade, buildKnowledgeCurve, cardForPoint, createSchedulerSnapshot, DEFAULT_DESIRED_RETENTION, DEFAULT_FSRS_PARAMETERS, ensureSchedulerCards, FSRS_ALGORITHM, FSRS_VERSION, gradeForStatus, gradeLabel, isAtOrBelowTarget, replayReviewLog, retrievability, reviewDayKey } from "../recall/fsrs";
import type { AppSettings, FsrsGrade, FsrsSchedulerSnapshot, KnowledgeRecord, RecallEvaluationDraft, RecallMode, RecallPoint, RecallPointType, RecallStatus, ReviewItem, ReviewRecord } from "../types";

interface RecallViewProps {
  settings: AppSettings;
  hasApiKey: boolean;
  onOpenSettings: () => void;
}

type EditorState = { knowledge: KnowledgeRecord; points: RecallPoint[] };
type KnowledgeIntakeMode = "manual" | "ai";
type RecallSessionState = {
  knowledge: KnowledgeRecord;
  point?: RecallPoint;
  mode: RecallMode;
  answer: string;
  submitted: boolean;
  items: ReviewItem[];
  source: "manual" | "ai";
  nextReviewAt: string;
  aiMessage?: string;
  selectionReason?: string;
  submittedAt?: string;
};

const STATUS_OPTIONS: RecallStatus[] = ["correct", "wrong", "omitted", "incomplete", "misunderstood"];
const POINT_TYPES: RecallPointType[] = ["framework", "mechanism", "relationship"];
const MODE_LABELS: Record<RecallMode, string> = { framework: "框架回忆", point: "定点提问", full: "完整复述" };
const TYPE_LABELS: Record<RecallPointType, string> = { framework: "框架", mechanism: "机制", relationship: "关系" };

function replayAndMarkMigration(record: KnowledgeRecord, points: RecallPoint[], reviews: ReviewRecord[], desiredRetention: number): FsrsSchedulerSnapshot {
  const createdAt = new Date(record.createdAt);
  return replayReviewLog(record.id, points.map((point) => point.pointId), reviews, { createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt, desiredRetention }).snapshot;
}

function knowledgeCreatedAt(record: KnowledgeRecord): Date {
  const date = new Date(record.createdAt);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toLocalDateTimeValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalDateTimeValue(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function formatReviewDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function reviewPrompt(title: string, review: ReviewRecord, point?: RecallPoint): string {
  if (point?.prompt) return point.prompt;
  if (review.mode === "full") return `请用自己的话完整复述“${title}”。`;
  if (review.mode === "framework") return `不看原文，回忆“${title}”的关键概念及其关系。`;
  return `请回忆“${title}”的核心内容。`;
}

function newKnowledge(): KnowledgeRecord {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: "", markdown: "", tags: "", createdAt: now, updatedAt: now };
}

function defaultNextReviewAt(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function latestReviews(reviews: ReviewRecord[]): Map<string, ReviewRecord> {
  const result = new Map<string, ReviewRecord>();
  [...reviews].sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt)).forEach((review) => result.set(review.knowledgeId, review));
  return result;
}

function MarkdownPreview({ value }: { value: string }) {
  const blocks = parseSimpleMarkdown(value);
  return <div className="recall-markdown">
    {blocks.map((block, index) => {
      if (block.kind === "heading") {
        if (block.level === 1) return <h1 key={index}>{block.text}</h1>;
        if (block.level === 2) return <h2 key={index}>{block.text}</h2>;
        if (block.level === 3) return <h3 key={index}>{block.text}</h3>;
        if (block.level === 4) return <h4 key={index}>{block.text}</h4>;
        if (block.level === 5) return <h5 key={index}>{block.text}</h5>;
        return <h6 key={index}>{block.text}</h6>;
      }
      if (block.kind === "unordered-list") return <ul key={index}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
      if (block.kind === "ordered-list") return <ol key={index}>{block.items.map((item) => <li key={item}>{item}</li>)}</ol>;
      return <p key={index}>{block.lines.join(" ")}</p>;
    })}
  </div>;
}

function TagTree({ nodes, selected, expanded, onSelect, onToggle }: {
  nodes: ReturnType<typeof buildTagTree>;
  selected: string;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return <div className="recall-tag-tree">
    <button type="button" className={!selected ? "tag-tree-row active" : "tag-tree-row"} onClick={() => onSelect("")}>全部标签</button>
    {nodes.map((node) => <TagTreeNode key={node.path} node={node} selected={selected} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />)}
  </div>;
}

function TagTreeNode({ node, selected, expanded, onSelect, onToggle }: {
  node: ReturnType<typeof buildTagTree>[number];
  selected: string;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  return <div>
    <div className={selected === node.path ? "tag-tree-row active" : "tag-tree-row"} style={{ paddingLeft: `${8 + node.depth * 17}px` }}>
      {hasChildren ? <button type="button" className="tag-tree-toggle" onClick={() => onToggle(node.path)} aria-label={isOpen ? `收起 ${node.label}` : `展开 ${node.label}`}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="tag-tree-spacer" />}
      <button type="button" className="tag-tree-label" onClick={() => onSelect(node.path)}>{node.label}</button>
    </div>
    {isOpen && node.children.map((child) => <TagTreeNode key={child.path} node={child} selected={selected} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />)}
  </div>;
}

function KnowledgeEditor({ initial, points: initialPoints, hasApiKey, onOpenSettings, onClose, onSaved, onDeleted }: {
  initial: KnowledgeRecord;
  points: RecallPoint[];
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
  onSaved: (knowledge: KnowledgeRecord, points: RecallPoint[]) => void;
  onDeleted: (id: string) => void;
}) {
  const [knowledge, setKnowledge] = useState(initial);
  const [points, setPoints] = useState(initialPoints);
  const [saving, setSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [intakeMode, setIntakeMode] = useState<KnowledgeIntakeMode>("manual");
  const [importText, setImportText] = useState(initial.markdown);
  const [activePointId, setActivePointId] = useState<string | null>(initialPoints[0]?.pointId ?? null);
  const isNew = !initial.title && !initial.markdown;

  function update(field: keyof KnowledgeRecord, value: string) {
    setKnowledge((current) => ({ ...current, [field]: value, updatedAt: new Date().toISOString() }));
  }

  async function parseKnowledge() {
    if (!importText.trim()) { setError("请先粘贴 Markdown 纯文本。"); return; }
    if (!hasApiKey) { setError("请先在 Settings 中配置 AI Provider 和 API key。"); return; }
    setParsing(true); setError(null);
    try {
      const parsed = await invoke<{ title: string; tags: string; sourceUrl: string; sourceNote: string }>("parse_knowledge_content", { request: { content: importText } });
      setKnowledge((current) => ({ ...current, title: parsed.title.trim(), markdown: importText, tags: parsed.tags.trim(), sourceUrl: parsed.sourceUrl.trim() || undefined, sourceNote: parsed.sourceNote.trim() || undefined, updatedAt: new Date().toISOString() }));
      setIntakeMode("manual");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setParsing(false); }
  }

  function addPoint() {
    const point = { pointId: crypto.randomUUID(), knowledgeId: knowledge.id, type: "framework" as const, prompt: "", reference: "", order: points.length };
    setPoints((current) => [...current, point]);
    setActivePointId(point.pointId);
  }

  function movePoint(index: number, direction: -1 | 1) {
    const next = [...points];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPoints(next.map((point, order) => ({ ...point, order })));
  }

  function removePoint(pointId: string) {
    const remaining = points.filter((point) => point.pointId !== pointId);
    setPoints(remaining);
    if (activePointId === pointId) setActivePointId(remaining[Math.min(points.findIndex((point) => point.pointId === pointId), remaining.length - 1)]?.pointId ?? null);
  }

  async function draftPoints() {
    if (!knowledge.markdown.trim()) { setError("请先输入 Markdown 正文，再让 AI 起草抽查点。"); return; }
    setDrafting(true); setError(null);
    try {
      const draft = await invoke<{ items: Array<{ type: RecallPointType; prompt: string; reference: string }> }>("draft_recall_points", { request: { title: knowledge.title, markdown: knowledge.markdown } });
      const drafted = draft.items.map((item, index) => ({ pointId: crypto.randomUUID(), knowledgeId: knowledge.id, type: item.type, prompt: item.prompt, reference: item.reference, order: index }));
      setPoints(drafted);
      setActivePointId(drafted[0]?.pointId ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setDrafting(false); }
  }

  async function save() {
    if (!knowledge.title.trim() || !knowledge.markdown.trim()) {
      setError("标题和 Markdown 正文不能为空。");
      return;
    }
    if (Number.isNaN(new Date(knowledge.createdAt).getTime())) {
      setError("加入时间必须是有效的日期和时间。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = { ...knowledge, title: knowledge.title.trim(), tags: normalizeTags(knowledge.tags).join("/"), updatedAt: new Date().toISOString() };
      await saveKnowledge(saved);
      await saveRecallPoints(saved.id, points.map((point, order) => ({ ...point, knowledgeId: saved.id, order })));
      onSaved(saved, points.map((point, order) => ({ ...point, knowledgeId: saved.id, order })));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleteArmed) { setDeleteArmed(true); return; }
    await deleteKnowledge(knowledge.id);
    onDeleted(knowledge.id);
  }

  return <div className="sheet-backdrop recall-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="side-sheet recall-editor-sheet" aria-labelledby="recall-editor-title">
      <header className="sheet-header"><div><span className="eyebrow">KNOWLEDGE NOTE</span><h2 id="recall-editor-title">{isNew ? "加入知识" : "编辑知识"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="sheet-form recall-editor-form">
        {isNew && <div className="recall-intake-switch" role="tablist" aria-label="知识录入方式"><button type="button" role="tab" aria-selected={intakeMode === "manual"} className={intakeMode === "manual" ? "active" : ""} onClick={() => setIntakeMode("manual")}>手动添加</button><button type="button" role="tab" aria-selected={intakeMode === "ai"} className={intakeMode === "ai" ? "active" : ""} onClick={() => setIntakeMode("ai")}>粘贴 Markdown · AI 识别</button></div>}
        {isNew && intakeMode === "ai" && <section className="recall-import-panel"><div className="recall-import-heading"><div><span>粘贴 Markdown 纯文本</span><small>AI 会推荐标题、层级标签和来源字段；正文仍保留你的原文，解析后可继续手动修改。</small></div><Sparkles size={17} /></div><textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴一段 Markdown 知识…" /><div className="recall-import-actions"><button className="primary-button" type="button" onClick={() => void parseKnowledge()} disabled={parsing || !hasApiKey}><Sparkles size={15} /> {parsing ? "识别中" : "AI 识别并填充"}</button>{!hasApiKey && <button className="text-button" type="button" onClick={onOpenSettings}>配置 Provider</button>}</div></section>}
        <label><span>标题</span><input value={knowledge.title} onChange={(event) => update("title", event.target.value)} placeholder="例如：制度同形化" autoFocus /></label>
        <label><span>层级标签</span><input value={knowledge.tags} onChange={(event) => update("tags", event.target.value)} placeholder="组织理论/制度理论/制度同形化" /></label>
        <label><span>加入时间</span><input type="datetime-local" value={toLocalDateTimeValue(knowledge.createdAt)} onChange={(event) => update("createdAt", fromLocalDateTimeValue(event.target.value))} /><small className="recall-field-help">默认使用系统审计时间；你可以改成知识实际加入回想的时间。</small></label>
        <div className="two-column-fields">
          <label><span>来源链接 <em>可选</em></span><input value={knowledge.sourceUrl ?? ""} onChange={(event) => update("sourceUrl", event.target.value)} placeholder="https://…" /></label>
          <label><span>来源备注 <em>可选</em></span><input value={knowledge.sourceNote ?? ""} onChange={(event) => update("sourceNote", event.target.value)} placeholder="书目、页码或备注" /></label>
        </div>
        <label><span>Markdown 正文</span><textarea className="recall-markdown-input" value={knowledge.markdown} onChange={(event) => update("markdown", event.target.value)} placeholder="用 Markdown 写下你希望长期保留的知识…" /></label>
        <details className="recall-editor-preview"><summary>实时预览 Markdown</summary><MarkdownPreview value={knowledge.markdown} /></details>
        <section className="recall-points-editor"><div className="recall-section-title"><div><span className="eyebrow">CHECKPOINTS</span><h3>抽查点</h3></div><div className="recall-point-actions"><button className="secondary-button" type="button" onClick={() => void draftPoints()} disabled={!hasApiKey || drafting}><Sparkles size={14} /> {drafting ? "起草中" : "AI 起草"}</button>{!hasApiKey && <button className="text-button" type="button" onClick={onOpenSettings}>配置 Provider</button>}</div></div>
          <p className="recall-muted">点击一个抽查点编辑其内容；每个点都有稳定的 pointId。</p>
          <div className="recall-point-nav" role="tablist" aria-label="抽查点列表">
            {points.map((point, index) => <button type="button" role="tab" aria-selected={activePointId === point.pointId} className={activePointId === point.pointId ? "active" : ""} key={point.pointId} onClick={() => setActivePointId(point.pointId)} title={point.prompt || `${TYPE_LABELS[point.type]}抽查点`}><span className="recall-point-dot">{index + 1}</span><span>{point.prompt || `${TYPE_LABELS[point.type]}抽查点`}</span></button>)}
            <button className="recall-point-add" type="button" onClick={addPoint} aria-label="新增抽查点" title="新增抽查点"><Plus size={15} /></button>
          </div>
          {points.length === 0 && <div className="recall-inline-empty">还没有抽查点。可以点击加号手动新增，或让 AI 起草。</div>}
          {points.find((point) => point.pointId === activePointId) && (() => {
            const point = points.find((item) => item.pointId === activePointId)!;
            const index = points.findIndex((item) => item.pointId === activePointId);
            return <div className="recall-point-panel" role="tabpanel">
              <div className="recall-point-toolbar"><select value={point.type} onChange={(event) => setPoints((current) => current.map((item) => item.pointId === point.pointId ? { ...item, type: event.target.value as RecallPointType } : item))}>{POINT_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}</select><span className="point-id">{point.pointId.slice(0, 8)}</span><span className="recall-point-position">{index + 1} / {points.length}</span><button className="icon-button" type="button" onClick={() => movePoint(index, -1)} disabled={index === 0} aria-label="上移"><ArrowUp size={14} /></button><button className="icon-button" type="button" onClick={() => movePoint(index, 1)} disabled={index === points.length - 1} aria-label="下移"><ArrowDown size={14} /></button><button className="icon-button" type="button" onClick={() => removePoint(point.pointId)} aria-label="删除抽查点"><Trash2 size={14} /></button></div>
              <label><span>抽查问题</span><input value={point.prompt} onChange={(event) => setPoints((current) => current.map((item) => item.pointId === point.pointId ? { ...item, prompt: event.target.value } : item))} placeholder="例如：制度同形化的三个来源是什么？" /></label>
              <label><span>参考要点</span><textarea value={point.reference} onChange={(event) => setPoints((current) => current.map((item) => item.pointId === point.pointId ? { ...item, reference: event.target.value } : item))} placeholder="提交后用于对照和反馈，不会在回答前显示。" rows={3} /></label>
            </div>;
          })()}
        </section>
        {error && <div className="inline-error">{error}</div>}
      </div>
      <footer className="settings-footer"><button className={deleteArmed ? "danger-button armed" : "danger-button"} type="button" onClick={remove} disabled={isNew}>{deleteArmed ? "再次点击确认删除" : "删除"}</button><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => void save()} disabled={saving}><Save size={15} /> {saving ? "保存中" : "保存知识"}</button></footer>
    </section>
  </div>;
}

function ReviewStatusBadge({ status, feedback }: { status: RecallStatus; feedback?: string }) {
  return <span className={`review-status status-${status}`} aria-label={statusLabel(status)} title={statusHint(status, feedback)} />;
}

export function RecallView({ settings, hasApiKey, onOpenSettings }: RecallViewProps) {
  const [knowledge, setKnowledge] = useState<KnowledgeRecord[]>([]);
  const [points, setPoints] = useState<RecallPoint[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [schedulers, setSchedulers] = useState<FsrsSchedulerSnapshot[]>([]);
  const [browserPreview, setBrowserPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [session, setSession] = useState<RecallSessionState | null>(null);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);
  const [randomMode, setRandomMode] = useState(false);
  const desiredRetention = Math.min(0.99, Math.max(0.5, settings.recall?.desiredRetention ?? DEFAULT_DESIRED_RETENTION));

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const data = await loadRecallData();
      const schedulerEntries: FsrsSchedulerSnapshot[] = [];
      for (const record of data.knowledge) {
        const recordPoints = pointsForKnowledge(data.points, record.id);
        const rebuilt = replayAndMarkMigration(record, recordPoints, data.reviews, desiredRetention);
        await saveRecallScheduler(rebuilt);
        schedulerEntries.push(rebuilt);
      }
      const normalizedKnowledge = data.knowledge.map((record) => {
        const scheduler = schedulerEntries.find((snapshot) => snapshot.knowledgeId === record.id);
        const nextReviewAt = scheduler && Object.keys(scheduler.cards).length > 0 ? Object.values(scheduler.cards).map((card) => card.due).sort()[0] : record.nextReviewAt;
        return nextReviewAt === record.nextReviewAt ? record : { ...record, nextReviewAt };
      });
      setKnowledge(normalizedKnowledge); setPoints(data.points); setReviews(data.reviews); setSchedulers(schedulerEntries); setBrowserPreview(data.browserPreview);
      setSelectedKnowledgeId((current) => current && normalizedKnowledge.some((item) => item.id === current) ? current : normalizedKnowledge[0]?.id ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, [desiredRetention]);

  const tagTree = useMemo(() => buildTagTree(knowledge), [knowledge]);
  const filtered = useMemo(() => knowledge.filter((item) => matchesTag(item, selectedTag)), [knowledge, selectedTag]);
  const latest = useMemo(() => latestReviews(reviews), [reviews]);
  const dueCount = useMemo(() => filtered.filter((item) => {
    const itemPoints = pointsForKnowledge(points, item.id);
    const scheduler = schedulers.find((snapshot) => snapshot.knowledgeId === item.id);
    return itemPoints.length === 0 ? (!item.nextReviewAt || new Date(item.nextReviewAt).getTime() <= Date.now()) : itemPoints.some((point) => isAtOrBelowTarget(scheduler?.cards[point.pointId], desiredRetention, new Date(), scheduler?.parameters));
  }).length, [desiredRetention, filtered, points, schedulers]);
  const selectedKnowledge = useMemo(() => filtered.find((item) => item.id === selectedKnowledgeId) ?? filtered[0], [filtered, selectedKnowledgeId]);
  const pointCount = (id: string) => pointsForKnowledge(points, id).length;

  function openNew() { setEditor({ knowledge: newKnowledge(), points: [] }); }
  function openEdit(item: KnowledgeRecord) { setEditor({ knowledge: item, points: pointsForKnowledge(points, item.id) }); }

  function startKnowledgeReview(item: KnowledgeRecord, forceRandom = false) {
    const itemPoints = pointsForKnowledge(points, item.id);
    const scheduler = schedulers.find((snapshot) => snapshot.knowledgeId === item.id);
    const candidates = itemPoints.length > 0
      ? itemPoints.map((point) => ({ knowledge: item, point, schedulerCard: scheduler?.cards[point.pointId], currentRetrievability: scheduler?.cards[point.pointId] ? retrievability(scheduler.cards[point.pointId], new Date(), scheduler.parameters) : undefined, lastReview: reviews.filter((review) => review.pointId === point.pointId).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))[0] }))
      : [{ knowledge: item, lastReview: latest.get(item.id) }];
    const selected = chooseCandidate(candidates, { random: forceRandom, targetRetention: desiredRetention });
    if (!selected.candidate) { setError(selected.reason); return; }
    const candidate = selected.candidate;
    const mode: RecallMode = candidate.point ? "framework" : "full";
    setSelectedKnowledgeId(item.id);
    setSession({ knowledge: candidate.knowledge, point: candidate.point, mode, answer: "", submitted: false, items: [], source: "manual", nextReviewAt: defaultNextReviewAt(), selectionReason: selected.reason });
    setError(null);
  }

  function startReview(forceRandom = randomMode) {
    const candidates = filtered.flatMap((item) => {
      const itemPoints = pointsForKnowledge(points, item.id);
      const scheduler = schedulers.find((snapshot) => snapshot.knowledgeId === item.id);
      return itemPoints.length > 0
        ? itemPoints.map((point) => ({ knowledge: item, point, schedulerCard: scheduler?.cards[point.pointId], currentRetrievability: scheduler?.cards[point.pointId] ? retrievability(scheduler.cards[point.pointId], new Date(), scheduler.parameters) : undefined, lastReview: reviews.filter((review) => review.pointId === point.pointId).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))[0] }))
        : [{ knowledge: item, lastReview: latest.get(item.id) }];
    });
    const selected = chooseCandidate(candidates, { random: forceRandom, targetRetention: desiredRetention });
    if (!selected.candidate) { setError(selected.reason); return; }
    const candidate = selected.candidate;
    const mode: RecallMode = candidate.point ? "framework" : "full";
    setSelectedKnowledgeId(candidate.knowledge.id);
    setSession({ knowledge: candidate.knowledge, point: candidate.point, mode, answer: "", submitted: false, items: [], source: "manual", nextReviewAt: defaultNextReviewAt(), selectionReason: selected.reason });
    setError(null);
  }

  function submitAnswer() {
    if (!session?.answer.trim()) return;
    const target = session.mode === "point" && session.point ? [session.point] : session.mode === "full" ? [] : pointsForKnowledge(points, session.knowledge.id);
    const items = target.length > 0 ? target.map((point) => ({ pointId: point.pointId, status: "omitted" as RecallStatus, grade: "Again" as FsrsGrade, evidence: "", feedback: "", accepted: true })) : [{ status: "omitted" as RecallStatus, grade: "Again" as FsrsGrade, evidence: "", feedback: "", accepted: true }];
    setSession({ ...session, submitted: true, submittedAt: new Date().toISOString(), items });
  }

  async function evaluateWithAi() {
    if (!session) return;
    try {
      const draft = await invoke<RecallEvaluationDraft>("generate_recall_evaluation", { request: {
        knowledgeId: session.knowledge.id, title: session.knowledge.title, markdown: session.knowledge.markdown, answer: session.answer, mode: session.mode, points: pointsForKnowledge(points, session.knowledge.id),
      }});
      setSession({ ...session, submitted: true, submittedAt: new Date().toISOString(), source: "ai", items: draft.items.map((item) => ({ ...item, grade: item.grade ?? gradeForStatus(item.status), accepted: false })), nextReviewAt: draft.nextReviewAt, aiMessage: draft.message });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function updateReviewItem(index: number, field: keyof ReviewItem, value: string | boolean) {
    if (!session) return;
    setSession({ ...session, items: session.items.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      if (field === "status") {
        const status = value as RecallStatus;
        return { ...item, status, grade: gradeForStatus(status) };
      }
      return { ...item, [field]: value };
    }) });
  }

  function acceptAllReviewItems() {
    if (!session) return;
    setSession({ ...session, items: session.items.map((item) => ({ ...item, accepted: true })) });
  }

  async function confirmReview() {
    if (!session) return;
    const confirmedAt = new Date().toISOString();
    const acceptedItems = session.items.filter((item) => item.accepted !== false);
    if (acceptedItems.length === 0) { setError("至少确认一条评价，或返回修改答案。"); return; }
    const knowledgePoints = pointsForKnowledge(points, session.knowledge.id);
    let scheduler = schedulers.find((snapshot) => snapshot.knowledgeId === session.knowledge.id)
      ?? createSchedulerSnapshot(session.knowledge.id, knowledgePoints.map((point) => point.pointId), knowledgeCreatedAt(session.knowledge), desiredRetention);
    if (scheduler.desiredRetention !== desiredRetention) {
      scheduler = createSchedulerSnapshot(session.knowledge.id, knowledgePoints.map((point) => point.pointId), knowledgeCreatedAt(session.knowledge), desiredRetention);
    }
    scheduler = ensureSchedulerCards(scheduler, knowledgePoints.map((point) => point.pointId));
    const records: ReviewRecord[] = [];
    const nextCards = { ...scheduler.cards };
    for (const item of acceptedItems) {
      const grade = item.grade ?? gradeForStatus(item.status);
      let nextReviewAt = session.nextReviewAt || defaultNextReviewAt();
      if (item.pointId) {
        const result = applyGrade(cardForPoint(scheduler, item.pointId, new Date(confirmedAt)), grade, new Date(confirmedAt), scheduler.parameters);
        nextCards[item.pointId] = result.card;
        nextReviewAt = result.due;
      } else {
        const pointResults = knowledgePoints.map((point) => applyGrade(cardForPoint(scheduler, point.pointId, new Date(confirmedAt)), grade, new Date(confirmedAt), scheduler.parameters));
        pointResults.forEach((result, index) => { nextCards[knowledgePoints[index].pointId] = result.card; });
        nextReviewAt = pointResults.map((result) => result.due).sort()[0] ?? nextReviewAt;
      }
      records.push({
        reviewId: crypto.randomUUID(), knowledgeId: session.knowledge.id, pointId: item.pointId, mode: session.mode, answer: session.answer, status: item.status, grade, feedback: item.feedback.trim() || statusHint(item.status), evidence: item.evidence?.trim() ?? "", confirmedAt, nextReviewAt, source: session.source, selectionReason: session.selectionReason, algorithm: FSRS_ALGORITHM, fsrsVersion: FSRS_VERSION, parameters: scheduler.parameters,
      });
    }
    const pendingReviews = [...reviews, ...records];
    const nextScheduler = replayReviewLog(session.knowledge.id, knowledgePoints.map((point) => point.pointId), pendingReviews, { createdAt: knowledgeCreatedAt(session.knowledge), now: new Date(confirmedAt), desiredRetention }).snapshot;
    try {
      for (const record of records) await appendReview(record);
      await saveRecallScheduler(nextScheduler);
      setReviews((current) => [...current, ...records]);
      setSchedulers((current) => [...current.filter((item) => item.knowledgeId !== nextScheduler.knowledgeId), nextScheduler]);
      const nextReviewAt = Object.values(nextScheduler.cards).map((card) => card.due).sort()[0] ?? records[0]?.nextReviewAt;
      setKnowledge((current) => current.map((item) => item.id === session.knowledge.id ? { ...item, nextReviewAt } : item));
      setSession(null);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function removeReview(reviewId: string): Promise<boolean> {
    const target = reviews.find((review) => review.reviewId === reviewId);
    if (!target) return false;
    try {
      await deleteRecallReview(target.knowledgeId, reviewId);
      const remainingReviews = reviews.filter((review) => review.reviewId !== reviewId);
      setReviews(remainingReviews);
      const record = knowledge.find((item) => item.id === target.knowledgeId);
      const recordPoints = pointsForKnowledge(points, target.knowledgeId);
      if (record) {
        const rebuilt = replayAndMarkMigration(record, recordPoints, remainingReviews, desiredRetention);
        setSchedulers((current) => [...current.filter((item) => item.knowledgeId !== target.knowledgeId), rebuilt]);
        const nextReviewAt = Object.values(rebuilt.cards).map((card) => card.due).sort()[0];
        setKnowledge((current) => current.map((item) => item.id === target.knowledgeId ? { ...item, nextReviewAt } : item));
        try {
          await saveRecallScheduler(rebuilt);
        } catch (reason) {
          setError(`历史结果已从 JSONL 删除，曲线已按剩余记录重算；FSRS 调度快照下次刷新时重建失败：${reason instanceof Error ? reason.message : String(reason)}`);
          return true;
        }
      }
      setError(null);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }

  if (loading) return <main className="recall-loading"><RefreshCw className="spin" size={18} /> 正在读取本地知识…</main>;

  return <main className="recall-workspace">
    <div className="recall-header"><div><span className="eyebrow">RECALL SPACE</span><h2>回想</h2><p>从本地 Markdown 出发，先回答，再确认反馈。模型曲线只使用已确认的复习记录和当前预览。</p></div><div className="recall-header-actions"><span className="recall-count">{filtered.length} 篇知识 · {dueCount} 待抽查</span><button className="secondary-button" type="button" onClick={() => void refresh()} title="重新读取"><RefreshCw size={14} /> 刷新</button><button className="primary-button" type="button" onClick={openNew}><Plus size={15} /> 加入知识</button></div></div>
    {browserPreview && <div className="recall-browser-note">浏览器预览模式：演示数据保存在当前浏览器内存/本地存储，不会写入桌面应用数据目录。</div>}
    {error && <div className="inline-error recall-global-error">{error}</div>}
    <div className="recall-layout">
      <aside className="recall-library"><div className="recall-library-toolbar"><strong>知识列表</strong><div className="tag-picker"><button className="tag-picker-trigger" type="button" aria-expanded={tagOpen} onClick={() => setTagOpen((open) => !open)}><span>{selectedTag || "全部标签"}</span><ChevronDown size={14} /></button>{tagOpen && <div className="tag-picker-menu"><TagTree nodes={tagTree} selected={selectedTag} expanded={expandedTags} onSelect={(path) => { setSelectedTag(path); setTagOpen(false); }} onToggle={(path) => setExpandedTags((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} /></div>}</div></div>
        <div className="recall-list">{filtered.length === 0 ? <div className="recall-empty"><FileText size={23} /><strong>没有匹配的知识</strong><p>清空标签筛选，或先加入一篇本地 Markdown 知识。</p><button className="secondary-button" type="button" onClick={() => setSelectedTag("")}>返回全部标签</button></div> : filtered.map((item) => <article className={selectedKnowledgeId === item.id ? "recall-note-card active" : "recall-note-card"} key={item.id}><button type="button" className="recall-note-main" onClick={() => setSelectedKnowledgeId(item.id)} aria-pressed={selectedKnowledgeId === item.id}><span className="recall-note-title">{item.title}</span><span className="recall-note-tags">{normalizeTags(item.tags).join(" / ") || "未分类"}</span><span className="recall-note-meta">{pointCount(item.id)} 个抽查点 · {item.nextReviewAt && new Date(item.nextReviewAt).getTime() > Date.now() ? "已安排" : "待抽查"}</span></button><button className="icon-button recall-note-edit" type="button" onClick={() => openEdit(item)} aria-label={`编辑 ${item.title}`} title="编辑知识"><Pencil size={14} /></button><button className="icon-button recall-note-start" type="button" onClick={() => { setRandomMode(false); startKnowledgeReview(item); }} aria-label={`开始抽查 ${item.title}`} title="开始抽查"><ArrowRightIcon /></button></article>)}</div>
      </aside>
      <section className="recall-focus">
    {!session ? selectedKnowledge ? <KnowledgeOverview knowledge={selectedKnowledge} points={pointsForKnowledge(points, selectedKnowledge.id)} reviews={reviews.filter((review) => review.knowledgeId === selectedKnowledge.id)} scheduler={schedulers.find((snapshot) => snapshot.knowledgeId === selectedKnowledge.id)} desiredRetention={desiredRetention} onEdit={() => openEdit(selectedKnowledge)} onStart={() => startKnowledgeReview(selectedKnowledge)} onRandomStart={() => startKnowledgeReview(selectedKnowledge, true)} onReviewDeleted={removeReview} /> : <div className="recall-start-card"><div className="recall-start-copy"><span className="eyebrow">READY WHEN YOU ARE</span><h3>把知识从“看过”变成“说得出来”</h3><p>默认优先 FSRS 到期和薄弱考点，也可以在当前标签范围内均匀随机来一条。</p></div><div className="recall-mode-preview">{(Object.keys(MODE_LABELS) as RecallMode[]).map((mode) => <div key={mode} className="recall-mode-card"><strong>{MODE_LABELS[mode]}</strong><span>{mode === "framework" ? "回忆结构与关键来源" : mode === "point" ? "解释一个具体考点" : "完整复述整篇知识"}</span></div>)}</div><div className="recall-start-actions"><button className="primary-button" type="button" onClick={() => startReview(false)} disabled={filtered.length === 0}><Sparkles size={15} /> 开始抽查</button><button className="secondary-button" type="button" onClick={() => startReview(true)} disabled={filtered.length === 0}>随机来一条</button><label className="recall-random-toggle"><input type="checkbox" checked={randomMode} onChange={(event) => setRandomMode(event.target.checked)} /> 下次默认随机</label></div></div> : <ReviewSession session={session} points={pointsForKnowledge(points, session.knowledge.id)} reviews={reviews.filter((review) => review.knowledgeId === session.knowledge.id)} scheduler={schedulers.find((snapshot) => snapshot.knowledgeId === session.knowledge.id)} desiredRetention={desiredRetention} hasApiKey={hasApiKey} onOpenSettings={onOpenSettings} onBack={() => setSession(null)} onModeChange={(mode) => setSession({ ...session, mode, point: mode === "point" ? pointsForKnowledge(points, session.knowledge.id)[0] : session.point, submitted: false, items: [] })} onPointChange={(pointId) => setSession({ ...session, point: pointsForKnowledge(points, session.knowledge.id).find((point) => point.pointId === pointId), submitted: false, items: [] })} onAnswerChange={(answer) => setSession({ ...session, answer })} onSubmit={submitAnswer} onAi={evaluateWithAi} onItemChange={updateReviewItem} onAcceptAll={acceptAllReviewItems} onConfirm={confirmReview} onReject={() => setSession({ ...session, submitted: false, items: [], source: "manual" })} onReviewDeleted={removeReview} />}
      </section>
    </div>
    {editor && <KnowledgeEditor initial={editor.knowledge} points={editor.points} hasApiKey={hasApiKey} onOpenSettings={onOpenSettings} onClose={() => setEditor(null)} onSaved={(saved, savedPoints) => { setKnowledge((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]); setPoints((current) => [...current.filter((item) => item.knowledgeId !== saved.id), ...savedPoints]); setSelectedKnowledgeId(saved.id); setEditor(null); void refresh(); }} onDeleted={(id) => { setKnowledge((current) => current.filter((item) => item.id !== id)); setPoints((current) => current.filter((item) => item.knowledgeId !== id)); setReviews((current) => current.filter((item) => item.knowledgeId !== id)); setSchedulers((current) => current.filter((item) => item.knowledgeId !== id)); setSelectedKnowledgeId((current) => current === id ? null : current); setEditor(null); }} />}
  </main>;
}

function ArrowRightIcon() { return <span aria-hidden="true">→</span>; }

function KnowledgeOverview({ knowledge, points, reviews, scheduler, desiredRetention, onEdit, onStart, onRandomStart, onReviewDeleted }: {
  knowledge: KnowledgeRecord;
  points: RecallPoint[];
  reviews: ReviewRecord[];
  scheduler?: FsrsSchedulerSnapshot;
  desiredRetention: number;
  onEdit: () => void;
  onStart: () => void;
  onRandomStart: () => void;
  onReviewDeleted: (reviewId: string) => Promise<boolean>;
}) {
  return <div className="knowledge-overview">
    <header className="knowledge-overview-header">
      <div><span className="eyebrow">KNOWLEDGE</span><h3>{knowledge.title}</h3><p>{normalizeTags(knowledge.tags).join(" / ") || "未分类"} · {points.length} 个抽查点</p></div>
      <div className="knowledge-overview-actions"><button className="icon-button" type="button" onClick={onEdit} aria-label="编辑知识" title="编辑知识"><Pencil size={15} /></button><button className="secondary-button" type="button" onClick={onRandomStart}>随机来一条</button><button className="primary-button" type="button" onClick={onStart}><Sparkles size={14} /> 开始抽查</button></div>
    </header>
    <MemoryCurve knowledgeId={knowledge.id} knowledgeTitle={knowledge.title} createdAt={knowledge.createdAt} points={points} reviews={reviews} scheduler={scheduler} desiredRetention={desiredRetention} onReviewDeleted={onReviewDeleted} />
  </div>;
}

function formatAxisTickDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(new Date(iso));
}

function formatMetric(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function MemoryCurve({ knowledgeId, knowledgeTitle, createdAt, points, reviews, scheduler, desiredRetention, pendingReviewIds = new Set<string>(), onReviewDeleted }: { knowledgeId: string; knowledgeTitle: string; createdAt?: string; points: RecallPoint[]; reviews: ReviewRecord[]; scheduler?: FsrsSchedulerSnapshot; desiredRetention: number; pendingReviewIds?: Set<string>; onReviewDeleted?: (reviewId: string) => Promise<boolean> }) {
  const [windowDays, setWindowDays] = useState<number | "all">(30);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [deletingReviewId, setDeletingReviewId] = useState<string | null>(null);
  const [deleteArmedReviewId, setDeleteArmedReviewId] = useState<string | null>(null);
  const now = new Date();
  const pointReviews = useMemo(() => reviews.filter((review) => review.knowledgeId === knowledgeId), [reviews, knowledgeId]);
  const curve = useMemo(() => {
    if (points.length === 0) return [];
    const candidateStart = windowDays === "all" && createdAt ? new Date(createdAt) : new Date(now.getTime() - Number(windowDays) * 86400000);
    const fallbackStart = new Date(now.getTime() - 30 * 86400000);
    const knowledgeStart = createdAt ? new Date(createdAt) : fallbackStart;
    const rangeStart = Number.isNaN(candidateStart.getTime()) ? fallbackStart : candidateStart;
    const startAt = Number.isNaN(knowledgeStart.getTime()) ? rangeStart : new Date(Math.max(rangeStart.getTime(), knowledgeStart.getTime()));
    const days = Math.max(0.001, (now.getTime() - startAt.getTime()) / 86400000);
    return buildKnowledgeCurve(knowledgeId, points.map((point) => point.pointId), reviews, scheduler, { now, startAt, createdAt: knowledgeStart, days, step: 0.25 });
  }, [createdAt, knowledgeId, points, pointReviews.length, reviews, scheduler, windowDays, now.getTime()]);
  const width = 640;
  const height = 238;
  const padding = { left: 57, right: 18, top: 18, bottom: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  if (points.length === 0) return null;
  if (curve.length === 0) return <section className="memory-curve" aria-label="记忆曲线"><div className="memory-curve-heading"><div><span className="eyebrow">MEMORY CURVE</span><h4>模型估计与测验观察</h4></div></div><p className="memory-curve-empty">加入至少一个抽查点后，这里会显示从加入时间开始的参考曲线。</p></section>;
  const maxDay = Math.max(0.0001, curve[curve.length - 1].day);
  const x = (day: number) => padding.left + (day / maxDay) * plotWidth;
  const y = (value: number) => padding.top + (1 - Math.max(0, Math.min(1, value))) * plotHeight;
  const pointsFor = (key: "reference" | "model") => curve.map((item) => `${x(item.day)},${y(item[key])}`).join(" ");
  const currentR = curve[curve.length - 1].model;
  const targetRetention = desiredRetention;
  const startDate = curve[0].at;
  const endDate = curve[curve.length - 1].at;
  const decay = scheduler?.parameters?.w?.[20] ?? DEFAULT_FSRS_PARAMETERS.w[20] ?? 0.1542;
  const factor = Math.exp(Math.log(0.9) / (-decay)) - 1;
  const tickStep = maxDay <= 10 ? 1 : maxDay <= 21 ? 2 : maxDay <= 45 ? 5 : maxDay <= 100 ? 10 : 30;
  const tickDays = [...Array(Math.floor(maxDay / tickStep) + 1)].map((_, index) => Math.min(maxDay, index * tickStep));
  if (tickDays[tickDays.length - 1] !== maxDay) tickDays.push(maxDay);
  const gridStep = maxDay <= 45 ? 1 : maxDay <= 120 ? 2 : 7;
  const gridDays = [...Array(Math.floor(maxDay / gridStep) + 1)].map((_, index) => Math.min(maxDay, index * gridStep));
  if (gridDays[gridDays.length - 1] !== maxDay) gridDays.push(maxDay);
  const gridValues = Array.from({ length: 11 }, (_, index) => index / 10);
  const selectedReviews = selectedDayKey ? pointReviews.filter((review) => reviewDayKey(review) === selectedDayKey).sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt)) : [];
  const selectedBest = curve.find((item) => item.observation?.dayKey === selectedDayKey)?.observation;
  const selectObservation = (dayKey: string) => setSelectedDayKey((current) => current === dayKey ? null : dayKey);
  const dateAtDay = (day: number) => new Date(new Date(startDate).getTime() + day * 86400000).toISOString();
  const currentCardSummary = (pointId?: string) => {
    const cards = pointId ? [scheduler?.cards[pointId]] : points.map((point) => scheduler?.cards[point.pointId]);
    return cards.filter((card): card is NonNullable<typeof card> => Boolean(card?.lastReview)).map((card) => `D ${formatMetric(card.difficulty, 1)}/10 · S ${formatMetric(card.stability, 2)} 天 · R ${Math.round(retrievability(card, now, scheduler?.parameters) * 100)}%`).join("；");
  };
  async function handleDeleteReview(reviewId: string) {
    if (!onReviewDeleted) return;
    if (deleteArmedReviewId !== reviewId) {
      setDeleteArmedReviewId(reviewId);
      return;
    }
    setDeletingReviewId(reviewId);
    try {
      if (await onReviewDeleted(reviewId)) setSelectedDayKey(null);
    } finally {
      setDeletingReviewId(null);
      setDeleteArmedReviewId(null);
    }
  }
  return <section className="memory-curve" aria-label="记忆曲线">
    <div className="memory-curve-heading"><div><span className="eyebrow">MEMORY CURVE</span><h4>模型估计与测验观察</h4></div><div className="memory-curve-controls"><span className="memory-curve-r">当前 R {Math.round(currentR * 100)}%</span><label><span>时间范围</span><select value={windowDays} onChange={(event) => { setWindowDays(event.target.value === "all" ? "all" : Number(event.target.value)); setSelectedDayKey(null); }}><option value={7}>近 7 天</option><option value={14}>近 14 天</option><option value={30}>近 30 天</option><option value={90}>近 90 天</option><option value="all">从开始到现在</option></select></label></div></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="记忆率 R 随日期变化的曲线图">
      {gridValues.map((value) => <line key={`h-${value}`} x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className="curve-grid" />)}
      {gridDays.map((day) => <line key={`v-${day}`} x1={x(day)} x2={x(day)} y1={padding.top} y2={height - padding.bottom} className="curve-grid curve-grid-vertical" />)}
      <line x1={padding.left} x2={width - padding.right} y1={y(targetRetention)} y2={y(targetRetention)} className="curve-target" />
      <text x={width - padding.right} y={y(targetRetention) - 5} textAnchor="end" className="curve-target-label">目标触发线 R={Math.round(targetRetention * 100)}%</text>
      <polyline points={pointsFor("reference")} className="curve-reference" />
      <polyline points={pointsFor("model")} className="curve-model" />
      {curve.filter((item) => item.observation).map((item) => {
        const observation = item.observation!;
        const pending = pendingReviewIds.has(observation.reviewId);
        return <g key={`${observation.dayKey}-${observation.reviewId}`} role="button" tabIndex={0} aria-label={`${observation.dayKey} ${gradeLabel(observation.grade)} 复习记录`} className="curve-observation-hit" onClick={() => selectObservation(observation.dayKey)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectObservation(observation.dayKey); } }}>
          <circle cx={x(item.day)} cy={y(observation.value)} r="5" className={`curve-observation curve-${observation.grade}${pending ? " curve-observation-pending" : ""}${selectedDayKey === observation.dayKey ? " curve-observation-selected" : ""}`} />
          <title>{observation.dayKey} · {gradeLabel(observation.grade)} · {statusLabel(observation.status)}{pending ? " · 尚未确认" : " · 点击查看详情"}</title>
        </g>;
      })}
      <line x1={x(Math.min(maxDay, Math.max(0, (now.getTime() - new Date(startDate).getTime()) / 86400000)))} x2={x(Math.min(maxDay, Math.max(0, (now.getTime() - new Date(startDate).getTime()) / 86400000)))} y1={padding.top} y2={height - padding.bottom} className="curve-today" />
      {gridValues.map((value) => <text key={`ylabel-${value}`} x={padding.left - 9} y={y(value) + 4} textAnchor="end">{Math.round(value * 100)}%</text>)}
      <text x="13" y={height / 2} textAnchor="middle" transform={`rotate(-90 13 ${height / 2})`} className="curve-axis-title">记忆率 R (%)</text>
      {tickDays.map((day) => <text key={`xlabel-${day}`} x={x(day)} y={height - 15} textAnchor={day === 0 ? "start" : day === maxDay ? "end" : "middle"}>{formatAxisTickDate(dateAtDay(day))}</text>)}
      <text x={width - padding.right} y={height - 2} textAnchor="end" className="curve-axis-title">日期</text>
    </svg>
    <div className="memory-curve-legend"><span><i className="legend-reference" />参考曲线</span><span><i className="legend-model" />模型估计</span><span><i className="legend-target" />目标触发线 R={Math.round(targetRetention * 100)}%</span><span><i className="legend-again" />Again · 错误/遗漏</span><span><i className="legend-hard" />Hard · 不完整/理解偏差</span><span><i className="legend-good" />Good · 正确</span><span><i className="legend-easy" />Easy · 轻松</span><span className="memory-curve-note">网格按日期刻度显示；点击复习点查看题目、状态和当前模型参数。每个自然日只显示当天最好结果，但原始记录仍完整保留。</span></div>
    <div className="memory-curve-equation"><span>FSRS-6.0</span><code>R(t,S) = (1 + {formatMetric(factor, 4)} × t / S)<sup>−{formatMetric(decay, 4)}</sup></code><small>t：距上次复习的天数　S：稳定性（R=90%时的时间尺度）</small></div>
    <details className="memory-curve-explanation"><summary>目标触发线、题目难度与调度计算</summary><p>90% 是复习触发目标，不是每天固定减少 10%。首次 Good 的 S 约为 2.3 天，所以模型估计大约 2–3 天降到 90%。</p><p>难度 <code>D</code>（1–10）会随 Again / Hard / Good / Easy 更新，影响下一次稳定性；它不等于当前 R。调度器按已完成的整天计算 t，未满 24 小时时 t=0，因此复习后短时间内调度 R 会保持 100%。图上的曲线则用同一公式按连续天数插值，让下降趋势更容易看清。</p><div className="curve-card-summary"><strong>当前抽查点模型（D / S / 调度器 R）</strong>{points.map((point) => { const card = scheduler?.cards[point.pointId]; return <span key={point.pointId} title={point.prompt}>{TYPE_LABELS[point.type]} · {card?.lastReview ? `D ${formatMetric(card.difficulty, 1)}/10 · S ${formatMetric(card.stability, 2)} 天 · R（整日）${Math.round(retrievability(card, now, scheduler?.parameters) * 100)}%` : "尚未复习"}</span>; })}</div></details>
    {selectedDayKey && <div className="curve-review-detail" aria-live="polite"><div className="curve-review-detail-heading"><div><span className="eyebrow">REVIEW DETAILS</span><h5>{selectedDayKey} · 当日最好结果 {selectedBest ? gradeLabel(selectedBest.grade) : ""}</h5></div><button type="button" className="icon-button" onClick={() => { setSelectedDayKey(null); setDeleteArmedReviewId(null); }} aria-label="关闭复习详情">×</button></div>{selectedReviews.length === 0 ? <p className="memory-curve-empty">这条记录只存在于当前预览中，尚未写入已确认日志。</p> : <div className="curve-review-list">{selectedReviews.map((review) => { const point = review.pointId ? points.find((candidate) => candidate.pointId === review.pointId) : undefined; const observation = curve.find((item) => item.observation?.reviewId === review.reviewId || item.observation?.rawReviewIds.includes(review.reviewId))?.observation; const summary = currentCardSummary(review.pointId); const armed = deleteArmedReviewId === review.reviewId; return <article key={review.reviewId} className="curve-review-record"><div className="curve-review-record-meta"><strong>{reviewPrompt(knowledgeTitle, review, point)}</strong><span>{formatReviewDate(review.confirmedAt)}</span></div><p className="curve-review-answer"><span>回答：</span>{review.answer || "（空）"}</p>{point?.reference && <p className="curve-review-answer"><span>参考：</span>{point.reference}</p>}{review.evidence && <p className="curve-review-answer"><span>答案证据：</span>{review.evidence}</p>}<div className="curve-review-status"><span className={`curve-status-dot curve-${review.grade ?? "Good"}`} />{statusLabel(review.status)} · {review.grade ? gradeLabel(review.grade) : gradeLabel(gradeForStatus(review.status))}{review.feedback ? ` · ${review.feedback}` : ""}</div>{observation && <div className="curve-review-status">观察值 {Math.round(observation.value * 100)}% · 当时模型 {Math.round((curve.find((item) => item.observation?.reviewId === observation.reviewId)?.model ?? 0) * 100)}%</div>}{summary && <div className="curve-review-status">当前模型：{summary}</div>}<div className="curve-review-status">下次计划：{formatReviewDate(review.nextReviewAt)}</div>{!pendingReviewIds.has(review.reviewId) && onReviewDeleted && <button type="button" className={armed ? "text-button curve-review-delete armed" : "text-button curve-review-delete"} disabled={deletingReviewId === review.reviewId} onClick={() => void handleDeleteReview(review.reviewId)}><Trash2 size={12} /> {deletingReviewId === review.reviewId ? "删除中…" : armed ? "再次点击确认删除" : "删除这条历史结果"}</button>}</article>; })}</div>}</div>}
  </section>;
}

function ReviewSession({ session, points, reviews, scheduler, desiredRetention, hasApiKey, onOpenSettings, onBack, onModeChange, onPointChange, onAnswerChange, onSubmit, onAi, onItemChange, onAcceptAll, onConfirm, onReject, onReviewDeleted }: {
  session: RecallSessionState;
  points: RecallPoint[];
  reviews: ReviewRecord[];
  scheduler?: FsrsSchedulerSnapshot;
  desiredRetention: number;
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onBack: () => void;
  onModeChange: (mode: RecallMode) => void;
  onPointChange: (pointId: string) => void;
  onAnswerChange: (answer: string) => void;
  onSubmit: () => void;
  onAi: () => void;
  onItemChange: (index: number, field: keyof ReviewItem, value: string | boolean) => void;
  onAcceptAll: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onReviewDeleted: (reviewId: string) => Promise<boolean>;
}) {
  const currentPoint = session.mode === "point" ? session.point ?? points[0] : undefined;
  const prompt = session.mode === "full" ? `请用自己的话完整复述“${session.knowledge.title}”。` : session.mode === "point" ? currentPoint?.prompt ?? "请选择一个抽查点。" : points.length > 0 ? `不看原文，回忆“${session.knowledge.title}”的关键概念及其关系。` : `请回忆“${session.knowledge.title}”的核心内容。`;
  const previewReviews = useMemo<ReviewRecord[]>(() => {
    if (!session.submitted) return [];
    const confirmedAt = session.submittedAt ?? new Date().toISOString();
    return session.items.map((item, index) => ({ reviewId: `pending-${session.knowledge.id}-${index}`, knowledgeId: session.knowledge.id, pointId: item.pointId, mode: session.mode, answer: session.answer, status: item.status, feedback: item.feedback, evidence: item.evidence ?? "", confirmedAt, nextReviewAt: session.nextReviewAt, source: session.source, grade: item.grade ?? gradeForStatus(item.status) }));
  }, [session]);
  const pendingReviewIds = useMemo(() => new Set(previewReviews.map((review) => review.reviewId)), [previewReviews]);
  return <div className="review-session"><div className="review-session-header"><button className="icon-button" type="button" onClick={onBack} aria-label="返回知识列表"><ArrowLeft size={17} /></button><div><span className="eyebrow">{MODE_LABELS[session.mode]}</span><h3>{session.knowledge.title}</h3></div><span className="review-session-lock" title={session.selectionReason}>本轮范围已固定 · {session.selectionReason ?? "按当前范围选择"}</span></div><div className="review-mode-switch" role="tablist" aria-label="抽查模式">{(Object.keys(MODE_LABELS) as RecallMode[]).map((mode) => <button key={mode} type="button" role="tab" aria-selected={session.mode === mode} className={session.mode === mode ? "active" : ""} onClick={() => onModeChange(mode)}>{MODE_LABELS[mode]}</button>)}</div>{session.mode === "point" && <label className="review-point-select"><span>抽查点</span><select value={currentPoint?.pointId ?? ""} onChange={(event) => onPointChange(event.target.value)}>{points.map((point) => <option key={point.pointId} value={point.pointId}>{point.prompt}</option>)}</select></label>}<div className="review-question"><span className="eyebrow">QUESTION</span><h4>{prompt}</h4><p>提交前不会显示标准答案；你可以先写下不完整的回忆。</p></div><textarea className="review-answer" value={session.answer} onChange={(event) => onAnswerChange(event.target.value)} disabled={session.submitted} placeholder="写下你的回答…" />{!session.submitted ? <div className="review-submit-actions"><button className="primary-button" type="button" onClick={onSubmit} disabled={!session.answer.trim()}>提交回答</button><button className="secondary-button" type="button" onClick={onAi} disabled={!session.answer.trim() || !hasApiKey}><Sparkles size={14} /> AI 生成评价草稿</button>{!hasApiKey && <button type="button" className="text-button" onClick={onOpenSettings}>配置 Provider</button>}</div> : <ReviewResult session={session} points={points} hasApiKey={hasApiKey} onAi={onAi} onItemChange={onItemChange} onAcceptAll={onAcceptAll} onConfirm={onConfirm} onReject={onReject} />}<MemoryCurve knowledgeId={session.knowledge.id} knowledgeTitle={session.knowledge.title} createdAt={session.knowledge.createdAt} points={points} reviews={[...reviews, ...previewReviews]} scheduler={scheduler} desiredRetention={desiredRetention} pendingReviewIds={pendingReviewIds} onReviewDeleted={onReviewDeleted} /></div>;
}

function ReviewResult({ session, points, hasApiKey, onAi, onItemChange, onAcceptAll, onConfirm, onReject }: {
  session: RecallSessionState;
  points: RecallPoint[];
  hasApiKey: boolean;
  onAi: () => void;
  onItemChange: (index: number, field: keyof ReviewItem, value: string | boolean) => void;
  onAcceptAll: () => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, session.items.length - 1)));
  }, [session.items.length]);
  const activeItem = session.items[activeIndex];
  const activePoint = activeItem?.pointId ? points.find((candidate) => candidate.pointId === activeItem.pointId) : undefined;

  return (
    <div className="review-result">
      <div className="review-result-grid">
        <div>
          <div className="review-column-heading"><span className="eyebrow">YOUR ANSWER</span></div>
          <div className="review-answer-readonly">{session.answer}</div>
        </div>
        <div>
          <div className="review-column-heading"><span className="eyebrow">ORIGINAL MARKDOWN</span></div>
          <MarkdownPreview value={session.knowledge.markdown} />
        </div>
      </div>

      <div className="review-feedback">
        <div className="review-feedback-heading">
          <div>
            <span className="eyebrow">FEEDBACK DRAFT</span>
            <h4>{session.source === "ai" ? "AI 草稿，逐条确认后保存" : "手动评价，待你确认"}</h4>
          </div>
          <div className="review-feedback-actions">
            <button className="secondary-button" type="button" onClick={onAcceptAll}><Check size={14} /> 全部同意</button>
            <button className="secondary-button" type="button" onClick={onReject}>全部拒绝</button>
            {hasApiKey && <button className="secondary-button" type="button" onClick={onAi}><Sparkles size={14} /> 重新评价</button>}
          </div>
        </div>

        {session.aiMessage && <p className="recall-muted">{session.aiMessage}</p>}

        <div className="review-step-nav" role="tablist" aria-label="反馈条目">
          <span className="review-step-count">{activeIndex + 1} / {session.items.length}</span>
          {session.items.map((item, index) => {
            const point = item.pointId ? points.find((candidate) => candidate.pointId === item.pointId) : undefined;
            return (
              <button
                key={item.pointId ?? "whole-answer"}
                type="button"
                role="tab"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onClick={() => setActiveIndex(index)}
                title={point?.prompt ?? "整篇复述"}
              >
                <span className="review-step-dot">{index + 1}</span>
                <span>{point?.prompt ?? "整篇复述"}</span>
                <ReviewStatusBadge status={item.status} feedback={item.feedback} />
              </button>
            );
          })}
        </div>

        {activeItem && (
          <div className={activeItem.accepted === false ? "review-item review-step-panel is-rejected" : "review-item review-step-panel"}>
            <div className="review-item-title">
              <label className="review-item-accept">
                <input type="checkbox" checked={activeItem.accepted !== false} onChange={(event) => onItemChange(activeIndex, "accepted", event.target.checked)} />
                <span>接受此条</span>
              </label>
              <ReviewStatusBadge status={activeItem.status} feedback={activeItem.feedback} />
              <strong>{activePoint?.prompt ?? "整篇复述"}</strong>
            </div>
            {activePoint && <p className="review-reference">参考要点：{activePoint.reference}</p>}
            <div className="review-item-fields">
              <label>
                <span>状态</span>
                <select value={activeItem.status} onChange={(event) => onItemChange(activeIndex, "status", event.target.value)}>
                  {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              </label>
              <label>
                <span>FSRS Grade</span>
                <select value={activeItem.grade ?? gradeForStatus(activeItem.status)} onChange={(event) => onItemChange(activeIndex, "grade", event.target.value)}>
                  {(["Again", "Hard", "Good", "Easy"] as FsrsGrade[]).map((grade) => <option key={grade} value={grade}>{gradeLabel(grade)}</option>)}
                </select>
              </label>
              <label>
                <span>短反馈</span>
                <input value={activeItem.feedback} onChange={(event) => onItemChange(activeIndex, "feedback", event.target.value)} placeholder={statusHint(activeItem.status)} />
              </label>
              <label>
                <span>答案证据 <em>可选</em></span>
                <input value={activeItem.evidence ?? ""} onChange={(event) => onItemChange(activeIndex, "evidence", event.target.value)} placeholder="能定位时再填写短语" />
              </label>
            </div>
            <div className="review-step-controls">
              <button className="secondary-button" type="button" onClick={() => setActiveIndex((current) => Math.max(0, current - 1))} disabled={activeIndex === 0}>上一条</button>
              <button className="secondary-button" type="button" onClick={() => setActiveIndex((current) => Math.min(session.items.length - 1, current + 1))} disabled={activeIndex === session.items.length - 1}>下一条</button>
            </div>
          </div>
        )}

        <div className="review-confirm-actions">
          <button className="secondary-button" type="button" onClick={onReject}>返回修改答案</button>
          <button className="primary-button" type="button" onClick={onConfirm}><Check size={15} /> 确认并保存记录</button>
        </div>
      </div>
    </div>
  );
}
