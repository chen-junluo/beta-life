import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, FileText, Plus, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseSimpleMarkdown } from "../simpleMarkdown";
import { appendReview, deleteKnowledge, loadRecallData, saveKnowledge, saveRecallPoints } from "../recallStorage";
import { buildTagTree, chooseCandidate, matchesTag, normalizeTags, pointsForKnowledge, statusHint, statusLabel } from "../recallLogic";
import type { AppSettings, KnowledgeRecord, RecallEvaluationDraft, RecallMode, RecallPoint, RecallPointType, RecallStatus, ReviewItem, ReviewRecord } from "../types";

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
};

const STATUS_OPTIONS: RecallStatus[] = ["correct", "wrong", "omitted", "incomplete", "misunderstood"];
const POINT_TYPES: RecallPointType[] = ["framework", "mechanism", "relationship"];
const MODE_LABELS: Record<RecallMode, string> = { framework: "框架回忆", point: "定点提问", full: "完整复述" };
const TYPE_LABELS: Record<RecallPointType, string> = { framework: "框架", mechanism: "机制", relationship: "关系" };

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
  const [browserPreview, setBrowserPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [session, setSession] = useState<RecallSessionState | null>(null);
  const [randomMode, setRandomMode] = useState(false);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const data = await loadRecallData();
      setKnowledge(data.knowledge); setPoints(data.points); setReviews(data.reviews); setBrowserPreview(data.browserPreview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  const tagTree = useMemo(() => buildTagTree(knowledge), [knowledge]);
  const filtered = useMemo(() => knowledge.filter((item) => matchesTag(item, selectedTag)), [knowledge, selectedTag]);
  const latest = useMemo(() => latestReviews(reviews), [reviews]);
  const dueCount = useMemo(() => filtered.filter((item) => !item.nextReviewAt || new Date(item.nextReviewAt).getTime() <= Date.now()).length, [filtered]);
  const pointCount = (id: string) => pointsForKnowledge(points, id).length;

  function openNew() { setEditor({ knowledge: newKnowledge(), points: [] }); }
  function openEdit(item: KnowledgeRecord) { setEditor({ knowledge: item, points: pointsForKnowledge(points, item.id) }); }

  function startReview(forceRandom = randomMode) {
    const candidates = filtered.map((item) => ({ knowledge: item, point: pointsForKnowledge(points, item.id)[0], lastReview: latest.get(item.id) }));
    const selected = chooseCandidate(candidates, { random: forceRandom });
    if (!selected.candidate) { setError(selected.reason); return; }
    const candidate = selected.candidate;
    const mode: RecallMode = candidate.point ? "framework" : "full";
    setSession({ knowledge: candidate.knowledge, point: candidate.point, mode, answer: "", submitted: false, items: [], source: "manual", nextReviewAt: defaultNextReviewAt(), selectionReason: selected.reason });
    setError(null);
  }

  function submitAnswer() {
    if (!session?.answer.trim()) return;
    const target = session.mode === "point" && session.point ? [session.point] : session.mode === "full" ? [] : pointsForKnowledge(points, session.knowledge.id);
    const items = target.length > 0 ? target.map((point) => ({ pointId: point.pointId, status: "omitted" as RecallStatus, evidence: "", feedback: "", accepted: true })) : [{ status: "omitted" as RecallStatus, evidence: "", feedback: "", accepted: true }];
    setSession({ ...session, submitted: true, items });
  }

  async function evaluateWithAi() {
    if (!session) return;
    try {
      const draft = await invoke<RecallEvaluationDraft>("generate_recall_evaluation", { request: {
        knowledgeId: session.knowledge.id, title: session.knowledge.title, markdown: session.knowledge.markdown, answer: session.answer, mode: session.mode, points: pointsForKnowledge(points, session.knowledge.id),
      }});
      setSession({ ...session, submitted: true, source: "ai", items: draft.items.map((item) => ({ ...item, accepted: false })), nextReviewAt: draft.nextReviewAt, aiMessage: draft.message });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function updateReviewItem(index: number, field: keyof ReviewItem, value: string | boolean) {
    if (!session) return;
    setSession({ ...session, items: session.items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item) });
  }

  function acceptAllReviewItems() {
    if (!session) return;
    setSession({ ...session, items: session.items.map((item) => ({ ...item, accepted: true })) });
  }

  async function confirmReview() {
    if (!session) return;
    const confirmedAt = new Date().toISOString();
    const nextReviewAt = session.nextReviewAt || defaultNextReviewAt();
    const acceptedItems = session.items.filter((item) => item.accepted !== false);
    if (acceptedItems.length === 0) { setError("至少确认一条评价，或返回修改答案。"); return; }
    const records = acceptedItems.map((item) => ({
      reviewId: crypto.randomUUID(), knowledgeId: session.knowledge.id, pointId: item.pointId, mode: session.mode, answer: session.answer, status: item.status, feedback: item.feedback.trim() || statusHint(item.status), evidence: item.evidence?.trim() ?? "", confirmedAt, nextReviewAt, source: session.source, selectionReason: session.selectionReason,
    } satisfies ReviewRecord));
    try {
      for (const record of records) await appendReview(record);
      setReviews((current) => [...current, ...records]);
      setKnowledge((current) => current.map((item) => item.id === session.knowledge.id ? { ...item, nextReviewAt } : item));
      setSession(null);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  if (loading) return <main className="recall-loading"><RefreshCw className="spin" size={18} /> 正在读取本地知识…</main>;

  return <main className="recall-workspace">
    <div className="recall-header"><div><span className="eyebrow">RECALL SPACE</span><h2>回想</h2><p>从本地 Markdown 出发，先回答，再确认反馈。这里不修改原始知识，也不使用记忆曲线。</p></div><div className="recall-header-actions"><span className="recall-count">{filtered.length} 篇知识 · {dueCount} 待抽查</span><button className="secondary-button" type="button" onClick={() => void refresh()} title="重新读取"><RefreshCw size={14} /> 刷新</button><button className="primary-button" type="button" onClick={openNew}><Plus size={15} /> 加入知识</button></div></div>
    {browserPreview && <div className="recall-browser-note">浏览器预览模式：演示数据保存在当前浏览器内存/本地存储，不会写入桌面应用数据目录。</div>}
    {error && <div className="inline-error recall-global-error">{error}</div>}
    <div className="recall-layout">
      <aside className="recall-library"><div className="recall-library-toolbar"><strong>知识列表</strong><div className="tag-picker"><button className="tag-picker-trigger" type="button" aria-expanded={tagOpen} onClick={() => setTagOpen((open) => !open)}><span>{selectedTag || "全部标签"}</span><ChevronDown size={14} /></button>{tagOpen && <div className="tag-picker-menu"><TagTree nodes={tagTree} selected={selectedTag} expanded={expandedTags} onSelect={(path) => { setSelectedTag(path); setTagOpen(false); }} onToggle={(path) => setExpandedTags((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} /></div>}</div></div>
        <div className="recall-list">{filtered.length === 0 ? <div className="recall-empty"><FileText size={23} /><strong>没有匹配的知识</strong><p>清空标签筛选，或先加入一篇本地 Markdown 知识。</p><button className="secondary-button" type="button" onClick={() => setSelectedTag("")}>返回全部标签</button></div> : filtered.map((item) => <article className="recall-note-card" key={item.id}><button type="button" className="recall-note-main" onClick={() => openEdit(item)}><span className="recall-note-title">{item.title}</span><span className="recall-note-tags">{normalizeTags(item.tags).join(" / ") || "未分类"}</span><span className="recall-note-meta">{pointCount(item.id)} 个抽查点 · {item.nextReviewAt && new Date(item.nextReviewAt).getTime() > Date.now() ? "已安排" : "待抽查"}</span></button><button className="icon-button recall-note-start" type="button" onClick={() => { setRandomMode(false); const one = [item]; const candidate = chooseCandidate(one.map((record) => ({ knowledge: record, point: pointsForKnowledge(points, record.id)[0], lastReview: latest.get(record.id) }))); if (candidate.candidate) { const point = candidate.candidate.point; setSession({ knowledge: item, point, mode: point ? "framework" : "full", answer: "", submitted: false, items: [], source: "manual", nextReviewAt: defaultNextReviewAt(), selectionReason: candidate.reason }); } }} aria-label={`开始抽查 ${item.title}`} title="开始抽查"><ArrowRightIcon /></button></article>)}</div>
      </aside>
      <section className="recall-focus">
    {!session ? <div className="recall-start-card"><div className="recall-start-copy"><span className="eyebrow">READY WHEN YOU ARE</span><h3>把知识从“看过”变成“说得出来”</h3><p>默认优先到期项目，再看最近一次较弱反馈。也可以在当前标签范围内均匀随机来一条。</p></div><div className="recall-mode-preview">{(Object.keys(MODE_LABELS) as RecallMode[]).map((mode) => <div key={mode} className="recall-mode-card"><strong>{MODE_LABELS[mode]}</strong><span>{mode === "framework" ? "回忆结构与关键来源" : mode === "point" ? "解释一个具体考点" : "完整复述整篇知识"}</span></div>)}</div><div className="recall-start-actions"><button className="primary-button" type="button" onClick={() => startReview(false)} disabled={filtered.length === 0}><Sparkles size={15} /> 开始抽查</button><button className="secondary-button" type="button" onClick={() => startReview(true)} disabled={filtered.length === 0}>随机来一条</button><label className="recall-random-toggle"><input type="checkbox" checked={randomMode} onChange={(event) => setRandomMode(event.target.checked)} /> 下次默认随机</label></div></div> : <ReviewSession session={session} points={pointsForKnowledge(points, session.knowledge.id)} hasApiKey={hasApiKey} onOpenSettings={onOpenSettings} onBack={() => setSession(null)} onModeChange={(mode) => setSession({ ...session, mode, point: mode === "point" ? pointsForKnowledge(points, session.knowledge.id)[0] : session.point, submitted: false, items: [] })} onPointChange={(pointId) => setSession({ ...session, point: pointsForKnowledge(points, session.knowledge.id).find((point) => point.pointId === pointId), submitted: false, items: [] })} onAnswerChange={(answer) => setSession({ ...session, answer })} onSubmit={submitAnswer} onAi={evaluateWithAi} onItemChange={updateReviewItem} onAcceptAll={acceptAllReviewItems} onNextReviewChange={(nextReviewAt) => setSession({ ...session, nextReviewAt })} onConfirm={confirmReview} onReject={() => setSession({ ...session, submitted: false, items: [], source: "manual" })} />}
      </section>
    </div>
    {editor && <KnowledgeEditor initial={editor.knowledge} points={editor.points} hasApiKey={hasApiKey} onOpenSettings={onOpenSettings} onClose={() => setEditor(null)} onSaved={(saved, savedPoints) => { setKnowledge((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]); setPoints((current) => [...current.filter((item) => item.knowledgeId !== saved.id), ...savedPoints]); setEditor(null); }} onDeleted={(id) => { setKnowledge((current) => current.filter((item) => item.id !== id)); setPoints((current) => current.filter((item) => item.knowledgeId !== id)); setReviews((current) => current.filter((item) => item.knowledgeId !== id)); setEditor(null); }} />}
  </main>;
}

function ArrowRightIcon() { return <span aria-hidden="true">→</span>; }

function ReviewSession({ session, points, hasApiKey, onOpenSettings, onBack, onModeChange, onPointChange, onAnswerChange, onSubmit, onAi, onItemChange, onAcceptAll, onNextReviewChange, onConfirm, onReject }: {
  session: RecallSessionState;
  points: RecallPoint[];
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
  onNextReviewChange: (value: string) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const currentPoint = session.mode === "point" ? session.point ?? points[0] : undefined;
  const prompt = session.mode === "full" ? `请用自己的话完整复述“${session.knowledge.title}”。` : session.mode === "point" ? currentPoint?.prompt ?? "请选择一个抽查点。" : points.length > 0 ? `不看原文，回忆“${session.knowledge.title}”的关键概念及其关系。` : `请回忆“${session.knowledge.title}”的核心内容。`;
  return <div className="review-session"><div className="review-session-header"><button className="icon-button" type="button" onClick={onBack} aria-label="返回知识列表"><ArrowLeft size={17} /></button><div><span className="eyebrow">{MODE_LABELS[session.mode]}</span><h3>{session.knowledge.title}</h3></div><span className="review-session-lock" title={session.selectionReason}>本轮范围已固定 · {session.selectionReason ?? "按当前范围选择"}</span></div><div className="review-mode-switch" role="tablist" aria-label="抽查模式">{(Object.keys(MODE_LABELS) as RecallMode[]).map((mode) => <button key={mode} type="button" role="tab" aria-selected={session.mode === mode} className={session.mode === mode ? "active" : ""} onClick={() => onModeChange(mode)}>{MODE_LABELS[mode]}</button>)}</div>{session.mode === "point" && <label className="review-point-select"><span>抽查点</span><select value={currentPoint?.pointId ?? ""} onChange={(event) => onPointChange(event.target.value)}>{points.map((point) => <option key={point.pointId} value={point.pointId}>{point.prompt}</option>)}</select></label>}<div className="review-question"><span className="eyebrow">QUESTION</span><h4>{prompt}</h4><p>提交前不会显示标准答案；你可以先写下不完整的回忆。</p></div><textarea className="review-answer" value={session.answer} onChange={(event) => onAnswerChange(event.target.value)} disabled={session.submitted} placeholder="写下你的回答…" />{!session.submitted ? <div className="review-submit-actions"><button className="primary-button" type="button" onClick={onSubmit} disabled={!session.answer.trim()}>提交回答</button><button className="secondary-button" type="button" onClick={onAi} disabled={!session.answer.trim() || !hasApiKey}><Sparkles size={14} /> AI 生成评价草稿</button>{!hasApiKey && <button type="button" className="text-button" onClick={onOpenSettings}>配置 Provider</button>}</div> : <ReviewResult session={session} points={points} hasApiKey={hasApiKey} onAi={onAi} onItemChange={onItemChange} onAcceptAll={onAcceptAll} onNextReviewChange={onNextReviewChange} onConfirm={onConfirm} onReject={onReject} />}</div>;
}

function ReviewResult({ session, points, hasApiKey, onAi, onItemChange, onAcceptAll, onNextReviewChange, onConfirm, onReject }: {
  session: RecallSessionState;
  points: RecallPoint[];
  hasApiKey: boolean;
  onAi: () => void;
  onItemChange: (index: number, field: keyof ReviewItem, value: string | boolean) => void;
  onAcceptAll: () => void;
  onNextReviewChange: (value: string) => void;
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

        <label className="next-review-field">
          <span>建议下一次复习时间</span>
          <input type="datetime-local" value={session.nextReviewAt.slice(0, 16)} onChange={(event) => onNextReviewChange(new Date(event.target.value).toISOString())} />
          <small>第一期只记录本地 nextReviewAt，不代表记忆曲线预测。</small>
        </label>
        <div className="review-confirm-actions">
          <button className="secondary-button" type="button" onClick={onReject}>返回修改答案</button>
          <button className="primary-button" type="button" onClick={onConfirm}><Check size={15} /> 确认并保存记录</button>
        </div>
      </div>
    </div>
  );
}
