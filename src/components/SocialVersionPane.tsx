import { Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pendingTurn, splitId, withEvaluation, withQuestion } from "../socialLogic";
import { aiSocialAnswer, aiSocialEvaluate, aiSocialQuestions, aiSocialScore, type SocialProposal } from "../socialStorage";
import type { SocialScore, SocialTurn, SocialVersion } from "../types";
import { MarkdownContent, MarkdownEditor } from "./MarkdownEditor";

interface SocialVersionPaneProps {
  role: string;
  version: SocialVersion;
  hidden: boolean;
  onSave: (next: SocialVersion) => Promise<void>;
  /** Renames the file; the tag is its date-less part, so this is also how the tag changes. */
  onRename: (name: string) => Promise<boolean>;
  onStar: () => void;
  onTrash: () => void;
  /** Writes the checked proposals into the two md files. */
  onProposals: (proposals: SocialProposal[]) => Promise<void>;
}

type Candidates = { mode: "new" | "follow"; questions: string[]; busy: boolean; error: string | null };

const message = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "出现了未知错误");
/** Input width in `em` (CJK glyphs are one em, Latin about 0.55), so the field matches the text it replaces. */
const fieldWidth = (value: string, min: number, pad: number) => {
  const units = Array.from(value).reduce((width, char) => width + (char.codePointAt(0)! >= 0x2e80 ? 1 : 0.55), 0);
  return `calc(${Math.max(units, min)}em + ${pad}px)`;
};
const tone = (score: number) => (score >= 8 ? "hi" : score >= 6 ? "mid" : "lo");
const PROPOSAL_LABELS: Record<SocialProposal["kind"], string> = { sample: "+ 正样本", principle: "+ 原则", trait: "+ 性格" };
const PROPOSAL_FILES: Record<SocialProposal["kind"], string> = { sample: "应对与正样本.md", principle: "应对与正样本.md", trait: "角色设定.md" };

function ScoreLine({ score, hasBetter, showBetter, onToggleBetter }: { score: SocialScore; hasBetter: boolean; showBetter: boolean; onToggleBetter: () => void }) {
  return (
    <div className="social-fb">
      <span className={`social-score ${tone(score.score)}`}>{score.score}/10</span>
      <span>{score.comment}</span>
      {hasBetter && (
        <button type="button" className="social-better-toggle" onClick={(e) => { e.stopPropagation(); onToggleBetter(); }}>
          改进写法 {showBetter ? "▴" : "▾"}
        </button>
      )}
    </div>
  );
}

/** One version: flat Q/A rounds, inline AI candidates, evaluation, and the tab's own input bar. */
export function SocialVersionPane({ role, version, hidden, onSave, onRename, onStar, onTrash, onProposals }: SocialVersionPaneProps) {
  const pending = pendingTurn(version.turns);
  const [modeChoice, setModeChoice] = useState<"q" | "a">("a");
  const mode = pending === null ? "q" : modeChoice;
  const [input, setInput] = useState("");
  const [cands, setCands] = useState<Candidates | null>(null);
  const [alt, setAlt] = useState<{ index: number; text: string } | null>(null);
  const [better, setBetter] = useState<Record<number, string>>({});
  const [showBetter, setShowBetter] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<{ items: SocialProposal[]; checked: boolean[] } | null>(null);
  const [editing, setEditing] = useState<{ index: number; field: "q" | "a"; value: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [selected, setSelected] = useState<number | null>(null);
  /** The `C：` prerequisite while it is being edited; null when not editing it. */
  const [ctx, setCtx] = useState<string | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [armed, setArmed] = useState(false);
  /** The tag while it is being typed; null when not editing it. */
  const [tag, setTag] = useState<string | null>(null);
  const tagRef = useRef(tag);
  tagRef.current = tag;
  /** The version name while it is being typed; null when not renaming. */
  const [name, setName] = useState<string | null>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const lastAnswered = version.turns.map((turn) => !!turn.answer.trim()).lastIndexOf(true);

  async function run(key: string, task: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (problem) {
      setError(message(problem));
    } finally {
      setBusy(null);
    }
  }

  const withTurns = (turns: SocialTurn[]) => ({ ...version, turns });
  const setTurn = (index: number, patch: Partial<SocialTurn>) => withTurns(version.turns.map((turn, at) => (at === index ? { ...turn, ...patch } : turn)));

  function put() {
    const text = input.trim();
    if (!text) return;
    const next = mode === "q" ? withTurns(withQuestion(version.turns, text)) : setTurn(pending!, { answer: text });
    void run("put", async () => {
      await onSave(next);
      setInput("");
      setCands(null);
      setModeChoice(mode === "q" ? "a" : "q");
    });
  }

  const answer = (index: number) => run(`answer:${index}`, async () => {
    const text = await aiSocialAnswer(role, version.context, version.turns.slice(0, index + 1));
    if (version.turns[index].answer.trim()) setAlt({ index, text });
    else await onSave(setTurn(index, { answer: text }));
  });

  const score = (index: number) => run(`score:${index}`, async () => {
    const result = await aiSocialScore(role, version.context, version.turns, index);
    await onSave(setTurn(index, { score: { score: result.score, comment: result.comment } }));
    setBetter((map) => {
      const next = { ...map };
      if (result.better) next[index] = result.better;
      else delete next[index];
      return next;
    });
  });

  const suggest = (kind: "new" | "follow", exclude: string[] = []) => {
    setCands({ mode: kind, questions: [], busy: true, error: null });
    aiSocialQuestions(role, version.context, version.turns, kind, exclude)
      .then((questions) => setCands({ mode: kind, questions, busy: false, error: null }))
      .catch((problem) => setCands({ mode: kind, questions: [], busy: false, error: message(problem) }));
  };

  const useCandidate = (question: string) => run("put", async () => {
    await onSave(withTurns(withQuestion(version.turns, question)));
    setCands(null);
    setModeChoice("a");
  });

  const evaluate = () => run("evaluate", async () => {
    const result = await aiSocialEvaluate(role, version.context, version.turns);
    await onSave(withEvaluation(version, result));
    const answered = version.turns.flatMap((turn, index) => (turn.answer.trim() ? [index] : []));
    setBetter(Object.fromEntries(result.scores.flatMap((item, at) => (item.better ? [[answered[at], item.better]] : []))));
    setProposals(result.proposals.length ? { items: result.proposals, checked: result.proposals.map(() => true) } : null);
  });

  const confirmProposals = () => run("proposals", async () => {
    if (!proposals) return;
    await onProposals(proposals.items.filter((_, index) => proposals.checked[index]));
    setProposals(null);
  });

  /** Blur or Enter saves the field edited in place; an empty or unchanged value writes nothing. */
  async function commitEdit() {
    const current = editingRef.current;
    editingRef.current = null;
    setEditing(null);
    if (!current) return;
    const turn = version.turns[current.index];
    const value = current.value.trim();
    if (current.field === "q") {
      if (!value || value === turn.question) return;
      await run("edit", () => onSave(setTurn(current.index, { question: value })));
    } else if (value !== turn.answer.trim()) {
      await run("edit", () => onSave(setTurn(current.index, { answer: value, score: null })));
    }
  }

  function cancelEdit() {
    editingRef.current = null;
    setEditing(null);
  }

  /** The `C：` prerequisite saves on blur or `⌘↵`; an unchanged value writes nothing. */
  async function commitContext() {
    const value = ctxRef.current;
    ctxRef.current = null;
    setCtx(null);
    if (value === null || value.trim() === version.context.trim()) return;
    await run("context", () => onSave({ ...version, context: value.trim() }));
  }

  /** Delete / Backspace on a selected turn (not while typing) moves it out and saves; undo brings it back. */
  function removeTurn(index: number) {
    if (editing !== null) return;
    const turns = version.turns.filter((_, at) => at !== index);
    setSelected(null);
    setAlt(null);
    setBetter({});
    setShowBetter({});
    void run("delete", () => onSave(withTurns(turns)));
  }

  /** Delete / Backspace deletes the selected turn, unless the caret is in a field. */
  useEffect(() => {
    if (hidden || selected === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable='true'], .md-editor")) return;
      event.preventDefault();
      removeTurn(selected!);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hidden, selected, editing, version.turns]);

  /** The tag is the file name without its date, so saving it renames the file. */
  async function commitTag() {
    const value = tagRef.current;
    tagRef.current = null;
    setTag(null);
    if (value === null) return;
    const { suffix } = splitId(version.id);
    if (!value.trim() && !suffix) return;
    const desired = `${value.trim()}${suffix}`;
    if (desired === version.id) return;
    await run("tag", async () => { await onRename(desired); });
  }

  /** The file name saves on blur or Enter; an unchanged value writes nothing. */
  async function commitName() {
    const value = nameRef.current;
    nameRef.current = null;
    setName(null);
    if (value === null || value.trim() === version.id) return;
    await run("name", async () => { await onRename(value.trim()); });
  }

  const isBusy = (key: string) => busy === key;

  /** The turn that dock AI actions target: selected > pending > lastAnswered. */
  const aiTarget = selected !== null ? selected : pending !== null ? pending : lastAnswered === -1 ? null : lastAnswered;
  const scoreTarget = selected !== null ? selected : lastAnswered === -1 ? null : lastAnswered;

  function selectTurn(index: number) {
    setSelected((prev) => (prev === index ? null : index));
  }

  function startEdit(index: number, field: "q" | "a") {
    const turn = version.turns[index];
    editingRef.current = { index, field, value: field === "q" ? turn.question : turn.answer };
    setEditing(editingRef.current);
    setSelected(index);
  }

  return (
    <div className="social-pane" hidden={hidden} aria-label={version.id}>
      <header className="social-pane-head">
        <button type="button" className={`social-star ${version.starred ? "on" : ""}`} aria-label={version.starred ? `取消收藏 ${version.id}` : `收藏 ${version.id}`} aria-pressed={version.starred} onClick={onStar}><Star size={14} aria-hidden="true" /></button>
        {tag !== null ? (
          <input
            className="social-inline-field social-tag-input"
            autoFocus
            value={tag}
            style={{ width: fieldWidth(tag || "标签，如 进度询问", 2, 20) }}
            aria-label="标签"
            placeholder="标签，如 进度询问"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setTag(e.target.value)}
            onBlur={() => void commitTag()}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void commitTag(); if (e.key === "Escape") { tagRef.current = null; setTag(null); } }}
          />
        ) : (
          <button type="button" className={`social-tag ${version.topic ? "" : "empty"}`} onClick={() => { tagRef.current = version.topic; setTag(version.topic); }} title="点击编辑标签，会同时改文件名">
            {version.topic || "＋ 标签"}
          </button>
        )}
        {name !== null ? (
          <input
            className="social-inline-field social-name-input"
            autoFocus
            value={name}
            style={{ width: fieldWidth(name, 4, 2) }}
            aria-label="版本名"
            onFocus={(event) => event.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void commitName(); if (e.key === "Escape") { nameRef.current = null; setName(null); } }}
          />
        ) : (
          <h3 className="social-name" title="点击改名" onClick={() => { nameRef.current = version.id; setName(version.id); }}>{version.id}</h3>
        )}
        <span className="social-grow" />
        <button type="button" className={armed ? "danger-button armed social-sm" : "text-button social-sm"} onBlur={() => setArmed(false)} onClick={() => (armed ? onTrash() : setArmed(true))} title="移进 社交模拟器/.beta-life/trash/"><Trash2 size={12} aria-hidden="true" /> {armed ? "再点一次删除" : "删除"}</button>
        <button type="button" className="primary-button social-sm" disabled={busy !== null || lastAnswered === -1} onClick={() => void evaluate()}>{isBusy("evaluate") ? "评估中…" : version.status === "done" ? "重新评估" : "结束本轮并评估"}</button>
      </header>
      <div className="social-pane-body">
        {ctx !== null ? (
          <section className="social-ctx" aria-label="前提">
            <span className="social-lab c">C</span>
            <MarkdownEditor
              autoFocus="end"
              value={ctx}
              onChange={setCtx}
              onBlur={() => void commitContext()}
              onModEnter={() => void commitContext()}
              aria-label="前提"
              placeholder="这一轮的背景：你和对方的关系、场景、最近发生了什么…"
            />
          </section>
        ) : (
          <section className="social-ctx" aria-label="前提">
            <span className="social-lab c">C</span>
            {version.context.trim() ? (
              <div className="social-ctx-body" onClick={() => { ctxRef.current = version.context; setCtx(version.context); }} title="点击编辑">
                <MarkdownContent value={version.context} />
              </div>
            ) : (
              <span className="social-muted social-ctx-body" onClick={() => { ctxRef.current = ""; setCtx(""); }}>点这里写前提：你和对方的关系、场景、最近发生了什么…</span>
            )}
          </section>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {version.turns.map((turn, index) => (
          <div
            key={index}
            className={`social-turn ${index === pending ? "current" : ""} ${selected === index && index !== pending ? "selected" : ""}`}
            onClick={() => { if (editing?.index !== index) selectTurn(index); }}
          >
            <>
              <div className="social-line">
                <span className="social-lab q">Q</span>
                {editing?.index === index && editing.field === "q" ? (
                  <input
                    className="social-inline-field"
                    autoFocus
                    value={editing.value}
                    aria-label={`第 ${index + 1} 轮的问题`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void commitEdit(); if (e.key === "Escape") cancelEdit(); }}
                  />
                ) : turn.question.trim() ? (
                  <span className="social-q-content" onClick={(e) => { e.stopPropagation(); startEdit(index, "q"); }} title="点击编辑">
                    {turn.question}
                  </span>
                ) : (
                  // A blank version opens on an empty Q, so the placeholder is the only thing to click.
                  <span className="social-q-content social-muted" onClick={(e) => { e.stopPropagation(); startEdit(index, "q"); }} title="点击编辑">点这里写对方的问题，或用右下角「AI 出新问题」…</span>
                )}
              </div>
              <div className="social-line">
                <span className="social-lab a">A</span>
                {editing?.index === index && editing.field === "a" ? (
                  <div className="social-a-content social-a-edit" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}>
                    <MarkdownEditor
                      autoFocus="end"
                      value={editing.value}
                      onChange={(value) => setEditing({ ...editing, value })}
                      onBlur={() => void commitEdit()}
                      onModEnter={() => void commitEdit()}
                      aria-label={`第 ${index + 1} 轮的回答`}
                      placeholder="回答；复杂时最多两层 bullet"
                    />
                  </div>
                ) : turn.answer.trim() ? (
                  <div className="social-answer social-a-content" onClick={(e) => { e.stopPropagation(); startEdit(index, "a"); }} title="点击编辑">
                    <MarkdownContent value={turn.answer} />
                  </div>
                ) : (
                  <span className="social-muted social-a-content" onClick={(e) => { e.stopPropagation(); startEdit(index, "a"); }}>点这里写回答，或点「AI 代答」…</span>
                )}
              </div>
              {turn.score && (
                <ScoreLine
                  score={turn.score}
                  hasBetter={!!better[index]}
                  showBetter={!!showBetter[index]}
                  onToggleBetter={() => setShowBetter((prev) => ({ ...prev, [index]: !prev[index] }))}
                />
              )}
              {better[index] && showBetter[index] && (
                <div className="social-alt"><MarkdownContent value={better[index]} /></div>
              )}
              {alt?.index === index && (
                <div className="social-alt">
                  <span className="social-alt-h">AI 代答 · 备选，不覆盖原回答</span>
                  <MarkdownContent value={alt.text} />
                  <div className="social-row-end">
                    <button type="button" className="secondary-button social-sm" onClick={(e) => { e.stopPropagation(); setAlt(null); }}>不用</button>
                    <button type="button" className="primary-button social-sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void run("put", async () => { await onSave(setTurn(index, { answer: alt.text, score: null })); setAlt(null); }); }}>换成这条</button>
                  </div>
                </div>
              )}
            </>
          </div>
        ))}
        {cands && (
          <div className="social-cands" aria-label="候选问题">
            <div className="social-cands-head">
              <span>{cands.busy ? "AI 正在出题…" : `${cands.mode === "follow" ? "AI 出追问" : "AI 出新问题"} · 点「用」设为下一个 Q`}</span>
              <span className="social-grow" />
              <button type="button" className="secondary-button social-sm" disabled={cands.busy} onClick={() => suggest(cands.mode, cands.questions)}>换一批</button>
              <button type="button" className="text-button social-sm" onClick={() => setCands(null)}>收起</button>
            </div>
            {cands.error && <p className="inline-error" role="alert">{cands.error}</p>}
            {cands.questions.map((question) => (
              <div key={question} className="social-cand">
                <span>{question}</span>
                <button type="button" className="secondary-button social-sm" disabled={busy !== null || pending !== null} title={pending !== null ? "先回答当前这一轮" : undefined} onClick={() => void useCandidate(question)}>用</button>
              </div>
            ))}
          </div>
        )}
        {version.evaluation.trim() && (
          <section className="social-eval" aria-label="评估">
            <h4>整体调整方向</h4>
            <MarkdownContent value={version.evaluation} />
          </section>
        )}
        {proposals && (
          <section className="social-diff" aria-label="建议写入">
            <b>建议写入 · 勾选后确认</b>
            {proposals.items.map((item, index) => (
              <label key={index}>
                <input type="checkbox" checked={proposals.checked[index]} onChange={(event) => setProposals({ ...proposals, checked: proposals.checked.map((value, at) => (at === index ? event.target.checked : value)) })} />
                <span className="social-diff-item">
                  <span className="social-diff-head"><span className="social-add">{PROPOSAL_LABELS[item.kind]}</span> → <code>{PROPOSAL_FILES[item.kind]}</code></span>
                  {item.kind === "sample"
                    ? <MarkdownContent value={item.text} />
                    : <span className="social-diff-line">{item.text.replace(/\n/g, " ")}</span>}
                </span>
              </label>
            ))}
            <div className="social-row-end">
              <button type="button" className="secondary-button social-sm" onClick={() => setProposals(null)}>取消</button>
              <button type="button" className="primary-button social-sm" disabled={busy !== null || !proposals.checked.some(Boolean)} onClick={() => void confirmProposals()}>{isBusy("proposals") ? "写入中…" : "确认写入"}</button>
            </div>
          </section>
        )}
      </div>
      <div className="social-dock">
        <div className="social-dock-head">
          <div className="social-seg" role="group" aria-label="输入">
            <button type="button" className={mode === "q" ? "on" : ""} aria-pressed={mode === "q"} onClick={() => setModeChoice("q")}>写问题</button>
            <button type="button" className={mode === "a" ? "on" : ""} aria-pressed={mode === "a"} disabled={pending === null} onClick={() => setModeChoice("a")}>写回答</button>
          </div>
          <span className="social-muted social-hint">{mode === "q" ? "写对方的下一个问题" : pending !== null ? `正在回答：${version.turns[pending].question}` : ""}</span>
          <span className="social-grow" />
          <button type="button" className="secondary-button social-sm" disabled={cands?.busy} onClick={() => suggest("new")}>AI 出新问题</button>
          <button type="button" className="secondary-button social-sm" disabled={cands?.busy || lastAnswered === -1} onClick={() => suggest("follow")}>AI 出追问</button>
        </div>
        <div className="social-box">
          <MarkdownEditor value={input} onChange={setInput} onModEnter={put} rows={2} aria-label={mode === "q" ? "写问题" : "写回答"} placeholder={mode === "q" ? "写下对方可能会追问什么…" : "写下你的回答…简短；复杂时最多两层 bullet"} />
          <button type="button" className="secondary-button social-sm" disabled={busy !== null || aiTarget === null} onClick={() => aiTarget !== null && void answer(aiTarget)}>{isBusy(`answer:${aiTarget}`) ? "代答中…" : "AI 代答"}</button>
          <button type="button" className="secondary-button social-sm" disabled={busy !== null || scoreTarget === null || !version.turns[scoreTarget ?? 0]?.answer.trim()} onClick={() => scoreTarget !== null && void score(scoreTarget)}>{isBusy(`score:${scoreTarget}`) ? "评分中…" : "评一下"}</button>
          <button type="button" className="primary-button social-sm" disabled={busy !== null || !input.trim()} onClick={put}>放入</button>
        </div>
      </div>
    </div>
  );
}
