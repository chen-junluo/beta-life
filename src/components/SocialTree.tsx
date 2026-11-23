import { ChevronDown, ChevronRight, FileText, Plus, Star } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { scoreTrend } from "../socialLogic";
import { SOCIAL_FILE_NAMES } from "../socialStorage";
import type { SocialFileKind, SocialQuestionGroup, SocialRole, SocialVersionSummary } from "../types";

export type SocialWindow = { kind: "version"; role: string; id: string } | { kind: "file"; role: string; file: SocialFileKind };

export const windowKey = (window: SocialWindow) => (window.kind === "version" ? `v:${window.role}/${window.id}` : `f:${window.role}/${window.file}`);

interface SocialTreeProps {
  roles: SocialRole[] | null;
  active: string | null;
  onOpen: (window: SocialWindow) => void;
  onStar: (role: string, id: string, starred: boolean) => void;
  onPractice: (role: string, question: string, topic: string) => void;
  /** The dashed row at the bottom of a role's questions: opens a blank version to fill in. */
  onNewBlank: (role: string) => void;
  onNewRole: (name: string) => Promise<boolean>;
  onRenameRole: (role: string, name: string) => Promise<boolean>;
  onRenameVersion: (role: string, id: string, name: string) => Promise<boolean>;
  onTrashRole: (role: string) => void;
}

function Score({ version }: { version: SocialVersionSummary }) {
  if (version.average === null) return <span className="social-pill">{version.status === "open" ? "进行中" : "未评分"}</span>;
  const tone = version.average >= 8 ? "hi" : version.average >= 6 ? "mid" : "lo";
  return <span className={`social-score ${tone}`}>{version.average.toFixed(1)}</span>;
}

function NameForm({ initial, placeholder, onSubmit, onCancel }: { initial: string; placeholder: string; onSubmit: (name: string) => Promise<boolean> | void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    if ((await onSubmit(value.trim())) !== false) onCancel();
  }
  return (
    <form className="social-name-form" onSubmit={(event) => void submit(event)}>
      <input autoFocus value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => event.key === "Escape" && onCancel()} />
      <button type="submit" className="secondary-button social-sm">确定</button>
    </form>
  );
}

/** Rename in place: same row, same font size. Enter or blur saves, Escape cancels. */
function InlineName({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  async function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (save && next && next !== initial) await onCommit(next);
    onCancel();
  }
  return (
    <input
      className="social-inline-input"
      autoFocus
      value={value}
      aria-label="重命名"
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void finish(true); if (event.key === "Escape") void finish(false); }}
    />
  );
}

/** Derive a short topic slug from the question text (used when no prior topic exists). */
function autoTopic(question: string): string {
  return question.replace(/[？?！!。，,.…《》「」【】\s]+/g, "").slice(0, 6);
}

/** Left column: roles, each with its two md files, ★ 收藏, and 问题 → versions. */
export function SocialTree(props: SocialTreeProps) {
  const { roles, active, onOpen, onStar } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [foldedQuestions, setFoldedQuestions] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [renamingVersion, setRenamingVersion] = useState<string | null>(null);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const isOpen = (role: SocialRole, index: number) => (expanded.has(role.name) ? true : expanded.has(`-${role.name}`) ? false : index === 0);

  function practice(role: string, group: SocialQuestionGroup) {
    props.onPractice(role, group.question, group.topic || autoTopic(group.question));
  }

  function versionRow(role: string, version: SocialVersionSummary, label: string) {
    const key = windowKey({ kind: "version", role, id: version.id });
    return (
      <div key={version.id} className={`social-ver ${active === key ? "active" : ""}`} role="button" tabIndex={0} onClick={() => onOpen({ kind: "version", role, id: version.id })} onKeyDown={(event) => event.key === "Enter" && onOpen({ kind: "version", role, id: version.id })}>
        <button type="button" className={`social-star ${version.starred ? "on" : ""}`} aria-label={version.starred ? `取消收藏 ${version.id}` : `收藏 ${version.id}`} aria-pressed={version.starred} onClick={(event) => { event.stopPropagation(); onStar(role, version.id, !version.starred); }}>
          <Star size={12} aria-hidden="true" />
        </button>
        {renamingVersion === key
          ? <InlineName initial={version.id} onCommit={(name) => props.onRenameVersion(role, version.id, name)} onCancel={() => setRenamingVersion(null)} />
          : <span className="social-ver-name" title="双击改名" onDoubleClick={(event) => { event.stopPropagation(); setRenamingVersion(key); }}>{label}</span>}
        <Score version={version} />
      </div>
    );
  }

  return (
    <aside className="social-side" aria-label="角色">
      <div className="social-side-head">
        <strong>角色</strong>
        <button type="button" className="secondary-button social-sm" onClick={() => setAdding(true)}><Plus size={12} aria-hidden="true" /> 角色</button>
      </div>
      {adding && <NameForm initial="" placeholder="角色名，如 王老师" onSubmit={props.onNewRole} onCancel={() => setAdding(false)} />}
      <div className="social-tree">
        {roles === null && <p className="social-note">正在读取…</p>}
        {roles?.length === 0 && !adding && <p className="social-note">还没有角色。点「+ 角色」建一个，或在 AI 助手里 @社交模拟器 聊着起草角色设定。</p>}
        {roles?.map((role, index) => {
          const open = isOpen(role, index);
          const folded = foldedQuestions.has(role.name);
          return (
            <section key={role.name} className="social-role" aria-label={role.name}>
              {renaming === role.name ? (
                <div className="social-role-head"><InlineName initial={role.name} onCommit={(name) => props.onRenameRole(role.name, name)} onCancel={() => setRenaming(null)} /></div>
              ) : (
                <div className="social-role-head">
                  <button type="button" className="social-role-toggle" aria-expanded={open} onClick={() => setExpanded((set) => { const next = new Set(set); next.delete(role.name); next.delete(`-${role.name}`); next.add(open ? `-${role.name}` : role.name); return next; })}>
                    {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                    <span className="social-role-name">{role.name}</span>
                  </button>
                  <button type="button" className="text-button social-sm" onClick={() => setRenaming(role.name)}>改名</button>
                  <button type="button" className={`text-button social-sm ${armed === role.name ? "danger" : ""}`} onBlur={() => setArmed(null)} onClick={() => { if (armed === role.name) { setArmed(null); props.onTrashRole(role.name); } else setArmed(role.name); }} title="整个角色文件夹移进 社交模拟器/.beta-life/trash/">{armed === role.name ? "再点一次删除" : "删除"}</button>
                </div>
              )}
              {open && <div className="social-kids">
                {(["role", "playbook"] as const).map((file) => {
                  const key = windowKey({ kind: "file", role: role.name, file });
                  return (
                    <button type="button" key={file} className={`social-file ${active === key ? "active" : ""}`} onClick={() => onOpen({ kind: "file", role: role.name, file })}>
                      <FileText size={12} aria-hidden="true" /><span>{SOCIAL_FILE_NAMES[file]}</span>
                    </button>
                  );
                })}
                <div className="social-sec"><span>★ 收藏</span></div>
                {role.favorites.length === 0
                  ? <p className="social-note">点版本旁的 ★ 收藏</p>
                  : role.favorites.map((version) => versionRow(role.name, version, version.id))}
                <div className="social-sec social-fold" role="button" tabIndex={0} aria-expanded={!folded} onClick={() => setFoldedQuestions((set) => toggle(set, role.name))} onKeyDown={(event) => event.key === "Enter" && event.target === event.currentTarget && setFoldedQuestions((set) => toggle(set, role.name))}>
                  <span>{folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />} 问题 · {role.questions.length}</span>
                </div>
                {!folded && role.questions.map((group) => {
                  const trend = scoreTrend(group);
                  // A blank version has no question yet: list its dates flat, without a question line.
                  if (!group.question) {
                    return <div key={group.versions[0]?.id} className="social-q social-q-blank">{[...group.versions].reverse().map((version) => versionRow(role.name, version, version.date))}</div>;
                  }
                  const meta = [group.topic ? group.topic : autoTopic(group.question), `${group.versions.length} 个版本`, trend.includes("→") ? trend : "", group.versions.some((version) => version.status === "open") ? "进行中" : ""].filter(Boolean).join(" · ");
                  return (
                    <div key={group.question} className="social-q">
                      <div className="social-q-head">
                        <span className="social-q-text">{group.question}<span className="social-q-meta">{meta}</span></span>
                        <button type="button" className="secondary-button social-sm" onClick={() => practice(role.name, group)} title="新建今天的版本">练</button>
                      </div>
                      {[...group.versions].reverse().map((version) => versionRow(role.name, version, version.date))}
                    </div>
                  );
                })}
                {!folded && (
                  <button type="button" className="social-blank" onClick={() => props.onNewBlank(role.name)}>
                    <Plus size={12} aria-hidden="true" /> 新问题
                  </button>
                )}
              </div>}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
