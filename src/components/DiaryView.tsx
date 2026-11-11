import { ChevronLeft, ChevronRight, NotebookPen, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { bodyProblem, dayCode, dayLabel, dayPreview, dayTitle, monthCode, monthList, monthTitle, newDayBody } from "../diaryLogic";
import { listDiaryMonths, loadDiaryMonth, saveDiaryDay, type DiarySnapshot } from "../diaryStorage";
import type { DiaryDay } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";

/** Today before it is written: the editor shows the template, the file changes on the first edit. */
const NEW = "__new__";
const SAVE_DELAY = 700;

type SaveState = "saved" | "saving" | "error" | "dirty";

interface DiaryViewProps {
  template: string;
  /** Bump to re-read the month (edited outside beta-life, undo, an AI batch). */
  revision: number;
  /** One undo step; steps with the same key inside a short window merge (typing). */
  onHistory: (before: DiarySnapshot, after: DiarySnapshot, key: string) => void;
}

const settled = (text: string) => text.replace(/^\n+/, "").replace(/\n+$/, "");

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "出现了未知错误";
}

/** One month at a time: the month's days on the left, the chosen day's body in the editor on the right. */
export function DiaryView({ template, revision, onHistory }: DiaryViewProps) {
  const today = dayCode(new Date());
  const currentMonth = monthCode(new Date());
  const [files, setFiles] = useState<string[]>([]);
  const [month, setMonth] = useState(currentMonth);
  const [days, setDays] = useState<DiaryDay[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** Changes only when the user picks another day, so saving a new day does not remount the editor. */
  const [editorKey, setEditorKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: string | null } | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  // Refs mirror the state for saves that finish after the user moved on.
  const monthRef = useRef(month);
  const selectedRef = useRef(selected);
  const draftRef = useRef(draft);
  /** The body as last read or saved; null for today before it exists. */
  const baseRef = useRef<string | null>(null);
  /** `YYMMDD` of the selected day; null for the preamble. */
  const dateRef = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const onHistoryRef = useRef(onHistory);
  onHistoryRef.current = onHistory;

  const dirty = () => selectedRef.current !== null && settled(draftRef.current) !== settled(baseRef.current ?? newDayBody(template, today));

  function open(id: string | null, list: DiaryDay[]) {
    const day = list.find((item) => item.id === id);
    selectedRef.current = id;
    baseRef.current = day?.body ?? null;
    dateRef.current = id === NEW ? today : day?.date ?? null;
    draftRef.current = day?.body ?? (id === NEW ? newDayBody(template, today) : "");
    setSelected(id);
    setDraft(draftRef.current);
    setEditorKey((key) => key + 1);
    setProblem(null);
    setSaveState("saved");
    setDeleteArmed(false);
  }

  /** Today if it exists, else today's empty page in the current month, else the month's last day. */
  const defaultDay = useCallback((target: string, list: DiaryDay[]) => {
    if (list.some((day) => day.id === today)) return today;
    if (target === currentMonth) return NEW;
    return list.at(-1)?.id ?? null;
  }, [currentMonth, today]);

  const save = useCallback((force = false) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const run = async () => {
      const id = selectedRef.current;
      if (id === null || (!dirty() && !force)) return;
      const body = draftRef.current;
      // Today is only written once it has something in it.
      if (id === NEW && !settled(body).trim()) return;
      const issue = bodyProblem(body);
      setProblem(issue);
      if (issue) {
        setSaveState("dirty");
        return;
      }
      const target = monthRef.current;
      const base = baseRef.current;
      const date = dateRef.current;
      setSaveState("saving");
      try {
        const outcome = await saveDiaryDay({ month: target, id: id === NEW ? null : id, date, base, body, force });
        if (outcome.status === "conflict") {
          setConflict({ current: outcome.current });
          setSaveState("dirty");
          return;
        }
        const saved = outcome.month.days.find((day) => day.id === outcome.id);
        if (outcome.id) onHistoryRef.current({ month: target, id: outcome.id, date, body: base }, { month: target, id: outcome.id, date, body: saved?.body ?? null }, `${target}/${outcome.id}`);
        if (monthRef.current !== target) return;
        setDays(outcome.month.days);
        setFiles((list) => (list.includes(target) ? list : [...list, target].sort()));
        if (selectedRef.current === id) {
          baseRef.current = saved?.body ?? null;
          if (outcome.id && outcome.id !== id) {
            selectedRef.current = outcome.id;
            setSelected(outcome.id);
          }
          setSaveState(dirty() ? "dirty" : "saved");
        }
      } catch (error) {
        setProblem(`保存失败：${errorMessage(error)}`);
        setSaveState("error");
      }
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  }, [template, today]);

  const load = useCallback(async (target: string, keepSelection: boolean) => {
    try {
      const [list, data] = await Promise.all([listDiaryMonths(), loadDiaryMonth(target)]);
      setFiles(list);
      setLoadError(null);
      if (monthRef.current !== target) return;
      setDays(data.days);
      const id = selectedRef.current;
      if (keepSelection && id !== null && dirty()) return; // the next save reports a conflict if the day changed
      const stillThere = keepSelection && id !== null && (id === NEW ? !data.days.some((day) => day.id === today) : data.days.some((day) => day.id === id));
      if (stillThere) {
        const day = data.days.find((item) => item.id === id);
        if (day && day.body !== baseRef.current) {
          baseRef.current = day.body;
          draftRef.current = day.body;
          setDraft(day.body);
        }
      } else {
        open(defaultDay(target, data.days), data.days);
      }
    } catch (error) {
      setLoadError(errorMessage(error));
      setDays([]);
    }
  }, [defaultDay, template, today]);

  useEffect(() => {
    void load(monthRef.current, true);
  }, [load, revision]);

  // Leaving the panel saves what is pending.
  useEffect(() => () => {
    if (timer.current !== null) void save();
  }, [save]);

  async function goToMonth(target: string) {
    await save();
    monthRef.current = target;
    setMonth(target);
    setDays(null);
    selectedRef.current = null;
    void load(target, false);
  }

  async function pick(id: string) {
    if (id === selectedRef.current) return;
    await save();
    open(id, days ?? []);
  }

  function change(text: string) {
    draftRef.current = text;
    setDraft(text);
    setSaveState("dirty");
    setDeleteArmed(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY);
  }

  async function removeDay() {
    const id = selectedRef.current;
    if (id === null || id === NEW) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const target = monthRef.current;
    const base = baseRef.current;
    const date = dateRef.current;
    try {
      const outcome = await saveDiaryDay({ month: target, id, date, base, body: "", delete: true });
      if (outcome.status === "conflict") {
        setConflict({ current: outcome.current });
        return;
      }
      onHistoryRef.current({ month: target, id, date, body: base }, { month: target, id, date, body: null }, `${target}/${id}/delete`);
      setDays(outcome.month.days);
      open(defaultDay(target, outcome.month.days), outcome.month.days);
    } catch (error) {
      setProblem(`删除失败：${errorMessage(error)}`);
    }
  }

  async function resolveConflict(keepMine: boolean) {
    const current = conflict?.current ?? null;
    setConflict(null);
    if (keepMine) {
      await save(true);
      return;
    }
    if (current === null) {
      selectedRef.current = null;
      await load(monthRef.current, false);
      return;
    }
    baseRef.current = current;
    draftRef.current = current;
    setDraft(current);
    setEditorKey((key) => key + 1);
    setProblem(null);
    setSaveState("saved");
  }

  const months = monthList(files, currentMonth);
  const monthIndex = months.indexOf(month);
  const showNew = month === currentMonth && days !== null && !days.some((day) => day.id === today);
  const selectedDay = days?.find((day) => day.id === selected);
  const title = selected === NEW ? dayLabel(today) : selectedDay ? dayTitle(selectedDay) : "";
  const stateLabel = { saved: "已保存", saving: "保存中", error: "保存失败", dirty: "未保存" }[saveState];

  return (
    <main className="diary-workspace">
      <div className="diary-layout">
        <aside className="diary-list" aria-label="日记日期">
          <div className="diary-month">
            <button type="button" className="icon-button" onClick={() => void goToMonth(months[monthIndex - 1])} disabled={monthIndex <= 0} aria-label="上个月"><ChevronLeft size={16} /></button>
            <strong>{monthTitle(month)}</strong>
            <button type="button" className="icon-button" onClick={() => void goToMonth(months[monthIndex + 1])} disabled={monthIndex >= months.length - 1} aria-label="下个月"><ChevronRight size={16} /></button>
          </div>
          {month !== currentMonth && <button type="button" className="text-button diary-back-today" onClick={() => void goToMonth(currentMonth)}>回到本月</button>}
          <div className="diary-days">
            {days?.map((day) => (
              <button type="button" key={day.id} className={`diary-day ${selected === day.id ? "active" : ""}`} aria-current={selected === day.id ? "true" : undefined} onClick={() => void pick(day.id)} title={dayTitle(day)}>
                <span className="diary-day-title">
                  <span>{dayTitle(day)}</span>
                  {day.date === today && <span className="diary-today-badge">今天</span>}
                </span>
                <span className="diary-day-preview">{dayPreview(day.body) || "（还没写内容）"}</span>
              </button>
            ))}
            {showNew && (
              <button type="button" className={`diary-day is-new ${selected === NEW ? "active" : ""}`} aria-current={selected === NEW ? "true" : undefined} onClick={() => void pick(NEW)}>
                <span className="diary-day-title"><Plus size={13} aria-hidden="true" /><span>写今天 · {dayLabel(today)}</span></span>
              </button>
            )}
            {days?.length === 0 && !showNew && <p className="diary-empty-note">这个月还没有日记。</p>}
          </div>
        </aside>

        <section className="diary-page" aria-label={title || "日记"}>
          {loadError && <div className="inline-error diary-message" role="alert">无法读取日记：{loadError}</div>}
          {selected === null ? (
            <div className="diary-empty">
              <NotebookPen size={22} aria-hidden="true" />
              <p>{days === null ? "正在读取日记…" : "在左边选一天。"}</p>
            </div>
          ) : (
            <>
              <header className="diary-page-head">
                <h3 title={title}>{title}</h3>
                <span className={`save-state ${saveState === "dirty" ? "saving" : saveState}`} role="status">{selected === NEW && saveState === "saved" ? "开始写就会保存" : stateLabel}</span>
                {selected !== NEW && (
                  <button type="button" className={deleteArmed ? "danger-button armed" : "secondary-button"} onClick={() => void removeDay()} onBlur={() => setDeleteArmed(false)} title="从这个月的 md 里删掉这一天，可以 ⌘Z 撤销">
                    <Trash2 size={14} aria-hidden="true" /> {deleteArmed ? "再次点击确认删除" : "删除这一天"}
                  </button>
                )}
              </header>
              {problem && <div className="inline-error diary-message" role="alert">{problem}</div>}
              <div className="diary-editor-wrap">
                <MarkdownEditor
                  key={editorKey}
                  className="diary-editor"
                  value={draft}
                  onChange={change}
                  onBlur={() => void save()}
                  flavor="diary"
                  placeholder="写点什么：列表、多级列表、一段话都可以"
                  aria-label={`${title} 的日记`}
                  autoFocus={selected === NEW ? "end" : false}
                />
              </div>
            </>
          )}
        </section>
      </div>

      {conflict && (
        <div className="sheet-backdrop diary-conflict-backdrop">
          <section className="diary-conflict" role="alertdialog" aria-modal="true" aria-labelledby="diary-conflict-title">
            <h3 id="diary-conflict-title">{title} 在别处被改过</h3>
            <p>{conflict.current === null ? "这一天已经从文件里删掉了（例如在 Obsidian 里），而你在 beta-life 里还有没保存的修改。" : "这一天在文件里（例如 Obsidian 或另一台电脑同步过来）有新的修改，而你在 beta-life 里也改了它。"}</p>
            <div className="diary-conflict-actions">
              <button type="button" className="secondary-button" onClick={() => void resolveConflict(false)}>{conflict.current === null ? "放弃我的修改" : "用文件里的版本"}</button>
              <button type="button" className="primary-button" onClick={() => void resolveConflict(true)}>保留我的修改</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
