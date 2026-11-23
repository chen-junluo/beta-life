import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { loadSocialFile, saveSocialFile, SOCIAL_FILE_NAMES } from "../socialStorage";
import type { SocialFileKind } from "../types";

interface SocialFilePaneProps {
  role: string;
  file: SocialFileKind;
  hidden: boolean;
  /** Bump to re-read (edited in Obsidian, undo, proposals written). */
  revision: number;
  onHistory: (before: string, after: string) => void;
}

type SaveState = "saved" | "saving" | "dirty" | "error";
const message = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "出现了未知错误");

/** The text under the transparent textarea, `#` heading lines bold; the trailing newline keeps the last empty line's height. */
function Highlight({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, index) => (
        <Fragment key={index}>
          {index > 0 && "\n"}
          {/^#{1,6}\s/.test(line) ? <b>{line}</b> : line}
        </Fragment>
      ))}
      {"\n"}
    </>
  );
}

/** 角色设定.md or 应对与正样本.md, edited in place; the tab's input bar is hidden here. */
export function SocialFilePane({ role, file, hidden, revision, onHistory }: SocialFilePaneProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [state, setState] = useState<SaveState>("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const base = useRef<string | null>(null);
  const draftRef = useRef("");
  const timer = useRef<number | null>(null);
  const layer = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const body = await loadSocialFile(role, file);
      setProblem(null);
      // Unsaved typing wins; the next save reports the conflict.
      if (base.current !== null && draftRef.current !== base.current) return;
      base.current = body;
      draftRef.current = body;
      setDraft(body);
      setEditorKey((key) => key + 1);
    } catch (error) {
      setProblem(`无法读取：${message(error)}`);
    }
  }, [role, file]);

  useEffect(() => { void reload(); }, [reload, revision]);

  const save = useCallback(async (force = false) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const before = base.current;
    const body = draftRef.current;
    if (before === null || (body === before && !force)) return;
    setState("saving");
    try {
      const outcome = await saveSocialFile({ role, kind: file, base: before, body, force });
      if (outcome.status === "conflict") {
        setConflict(outcome.current);
        setState("dirty");
        return;
      }
      base.current = body;
      onHistory(before, body);
      setState(draftRef.current === body ? "saved" : "dirty");
    } catch (error) {
      setProblem(`保存失败：${message(error)}`);
      setState("error");
    }
  }, [role, file, onHistory]);

  function change(value: string) {
    draftRef.current = value;
    setDraft(value);
    setState("dirty");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 800);
  }

  async function resolve(keepMine: boolean) {
    const current = conflict ?? "";
    setConflict(null);
    if (keepMine) {
      base.current = current;
      await save(true);
      return;
    }
    base.current = current;
    draftRef.current = current;
    setDraft(current);
    setEditorKey((key) => key + 1);
    setState("saved");
  }

  const label = { saved: "已保存", saving: "保存中", dirty: "未保存", error: "保存失败" }[state];
  return (
    <div className="social-pane social-md" hidden={hidden} aria-label={`${role} ${SOCIAL_FILE_NAMES[file]}`}>
      <header className="social-pane-head">
        <h3>{SOCIAL_FILE_NAMES[file]}</h3>
        <span className="social-pill">{role}</span>
        <span className="social-grow" />
        <span className="social-muted">直接编辑，Obsidian 双向同步</span>
        <span className={`save-state ${state === "dirty" ? "saving" : state}`} role="status">{label}</span>
      </header>
      {problem && <p className="inline-error social-message" role="alert">{problem}</p>}
      {conflict !== null && (
        <div className="inline-error social-message social-conflict" role="alert">
          <span>这个文件在别处（例如 Obsidian）被改过，而这里也有没保存的修改。</span>
          <button type="button" className="secondary-button social-sm" onClick={() => void resolve(false)}>用文件里的版本</button>
          <button type="button" className="primary-button social-sm" onClick={() => void resolve(true)}>保留我的修改</button>
        </div>
      )}
      <div className="social-md-body">
        {draft !== null && (
          <div className="social-md-stack">
            <div className="social-md-layer" aria-hidden="true" ref={layer}><Highlight text={draft} /></div>
            <textarea
              key={editorKey}
              className="social-md-textarea"
              value={draft}
              onChange={(e) => change(e.target.value)}
              onScroll={(e) => { if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop; }}
              onBlur={() => void save()}
              aria-label={`${role} 的 ${SOCIAL_FILE_NAMES[file]}`}
              placeholder="## 身份与场景、## 性格、## 可能会问的问题 / ## 原则、## 正样本"
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
