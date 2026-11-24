import { Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  PALETTE,
  categoryOf,
  chainOf,
  familyColor,
  orderedCategories,
  orderedProjects,
  projectColor,
  type BoardEvent,
  type Project,
} from "../boardEvents";

/** A light swatch gets a dark ✓ on top. */
const luminance = (hex: string) => {
  const value = parseInt(hex.slice(1), 16);
  return (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;
};

/**
 * V5: one column of projects, a row expanding in place to its form. Colour is a live edit — the swatch
 * writes through at once so the tray and gantt follow; the other fields sit in a draft until 保存.
 */
export function BoardProjectEditor({ projects, events, projectFamilies, dark, selected, openId, onOpen, onSelect, onSave, onDelete, onCreate, onColor }: {
  projects: Project[];
  events: BoardEvent[];
  projectFamilies: string[];
  dark: boolean;
  selected: string | null;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onSelect: (id: string) => void;
  onSave: (project: Project) => void;
  onDelete: (id: string) => void;
  onCreate: (tag: string) => void;
  onColor: (id: string, color: string | null) => void;
}) {
  return (
    <>
      <div className="ms-eyebrow">
        PROJECT · 编辑
        <button type="button" className="text-button" onClick={() => onCreate(`新分类/新 project ${projects.length + 1}`)}><Plus size={13} /> 新建</button>
      </div>
      <ul className="pe-list">
        {orderedProjects(projects, projectFamilies).map((project) => {
          const open = project.id === openId && project.id === selected;
          const count = chainOf(project, events).length;
          return (
            <li
              key={project.id}
              className={`pe-item ${open ? "is-open" : ""}`}
              style={{ "--pe-c": projectColor(project, projects, projectFamilies, dark), "--cat-c": familyColor(project, projects, projectFamilies, dark) } as CSSProperties}
            >
              <button type="button" className="pe-row" aria-expanded={open} onClick={() => { onSelect(project.id); onOpen(open ? null : project.id); }}>
                <i className="pe-bar" />
                <span className="pe-name">{project.tag.split("/").slice(1).join("/") || project.tag}</span>
                <span className="pe-meta">{count ? `${count} 站` : "回托盘"}</span>
                <i className="pe-chev">›</i>
              </button>
              <div className={`pe-panel ${open ? "is-open" : ""}`} inert={!open}>
                <div className="pe-panel-inner">
                  {open && (
                    <ProjectForm
                      key={project.id}
                      project={project}
                      projects={projects}
                      events={events}
                      projectFamilies={projectFamilies}
                      dark={dark}
                      onSave={onSave}
                      onDelete={onDelete}
                      onDone={() => onOpen(null)}
                      onColor={onColor}
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ProjectForm({ project, projects, events, projectFamilies, dark, onSave, onDelete, onDone, onColor }: {
  project: Project;
  projects: Project[];
  events: BoardEvent[];
  projectFamilies: string[];
  dark: boolean;
  onSave: (project: Project) => void;
  onDelete: (id: string) => void;
  onDone: () => void;
  onColor: (id: string, color: string | null) => void;
}) {
  const [name, setName] = useState(project.tag.split("/").slice(1).join("/"));
  const [category, setCategory] = useState(categoryOf(project.tag));
  const [priority, setPriority] = useState(project.priority);
  const [head, setHead] = useState(project.head ?? "");
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [node, setNode] = useState<number | null>(null);
  const [hex, setHex] = useState(project.color ?? "");
  const palette = useRef<HTMLDivElement>(null);
  const dots = useRef<Map<number, HTMLButtonElement | null>>(new Map());

  useEffect(() => { setHex(project.color ?? ""); }, [project.color]);

  // 色板：再点一次色点、外点、Esc 都会收起，收起后焦点还给刚才那个色点
  useEffect(() => {
    if (!colorOpen) {
      dots.current.get(node ?? -1)?.focus();
      return;
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      if (palette.current?.contains(target) || target.closest(".pe-dot")) return;
      setColorOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setColorOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [colorOpen, node]);

  const chain = chainOf(project, events);
  const color = projectColor(project, projects, projectFamilies, dark);
  const follow = project.color === null;
  const categories = orderedCategories(projects, projectFamilies).concat(projectFamilies).filter((item, index, list) => list.indexOf(item) === index);

  const save = () => {
    const tag = `${newCategory?.trim() || category}/${name.trim() || project.tag.split("/").slice(1).join("/")}`;
    onSave({ ...project, tag, priority, head: head || null, updatedAt: Date.now() });
    onDone();
  };

  const commitHex = () => {
    if (/^#[0-9a-f]{6}$/i.test(hex.trim())) onColor(project.id, hex.trim().toLowerCase());
    else setHex(project.color ?? "");
  };

  return (
    <div className="pe-form">
      <label className="pe-field">
        <span>名称</span>
        <input className="ms-title-input pe-input" value={name} aria-label="project 名称" onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="pe-grid2">
        <div className="pe-field">
          <span>分类</span>
          {newCategory === null ? (
            <select
              className="pe-select"
              aria-label="project 分类"
              value={category}
              onChange={(event) => {
                if (event.target.value === "__new") setNewCategory("");
                else setCategory(event.target.value);
              }}
            >
              {categories.map((item) => <option key={item} value={item}>{item}</option>)}
              <option value="__new">＋ 新分类…</option>
            </select>
          ) : (
            <input className="pe-input" autoFocus value={newCategory} placeholder="新分类名" aria-label="新分类名" onChange={(event) => setNewCategory(event.target.value)} onBlur={() => { if (!newCategory.trim()) setNewCategory(null); }} />
          )}
        </div>
        <label className="pe-field">
          <span>priority</span>
          <select className="pe-select" aria-label="priority" value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <label className="pe-field">
        <span>chain 起点</span>
        <select className="pe-select" aria-label="chain 起点" value={head} onChange={(event) => setHead(event.target.value)}>
          <option value="">— 未分配（回托盘）—</option>
          {[...events].sort((a, b) => a.date.localeCompare(b.date)).map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
        </select>
      </label>

      <div className="pe-chain" style={{ "--pe-c": color, "--cat-c": familyColor(project, projects, projectFamilies, dark) } as CSSProperties}>
        <div className="pe-chain-head">
          <span className="pe-lbl">chain 预览</span>
          <span className="pe-n">{chain.length ? `${chain.length} 站` : "回托盘"}</span>
          <span className={`pe-col-state ${follow ? "is-follow" : ""}`}>{follow ? `跟随 ${categoryOf(project.tag)}` : color}</span>
        </div>
        <div className="pe-chain-row">
          {chain.length === 0 ? (
            <span className="pe-chain-empty">
              <button
                type="button"
                className="pe-dot"
                aria-label="修改颜色"
                aria-expanded={colorOpen}
                ref={(element) => { dots.current.set(0, element); }}
                onClick={() => { setNode(0); setColorOpen((open) => !open); }}
              ><i /></button>
              未分配 · 会回到托盘，等下一次拖到某事项上。
            </span>
          ) : chain.map((id, index) => {
            const event = events.find((item) => item.id === id);
            if (!event) return null;
            return (
              <Fragment key={id}>
                {index > 0 && <span className="pe-arr">→</span>}
                <span className={`pe-node ${node === index ? "is-sel" : ""}`}>
                  <button
                    type="button"
                    className="pe-dot"
                    aria-label={`修改颜色 · ${event.title}`}
                    aria-expanded={colorOpen}
                    ref={(element) => { dots.current.set(index, element); }}
                    onClick={() => { setNode(index); setColorOpen((open) => !open); }}
                  ><i /></button>
                  <button type="button" className="pe-nt" aria-pressed={node === index} onClick={() => setNode(node === index ? null : index)}>{event.title}</button>
                </span>
              </Fragment>
            );
          })}
        </div>
        <div className={`pe-colpanel ${colorOpen ? "is-open" : ""}`}>
          <div className="pe-colpanel-inner">
            <div className="pe-colbody" ref={palette}>
              <div className="pe-coltitle"><span>颜色</span><span className="pe-hint">点色块即生效</span></div>
              <div className={`pe-swrow ${follow ? "is-follow" : ""}`} role="group" aria-label="project 颜色">
                {PALETTE.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className="pe-sw"
                    style={{ "--c": swatch, "--ck": luminance(swatch) > 0.56 ? "#16202c" : "#ffffff" } as CSSProperties}
                    aria-pressed={!follow && project.color === swatch}
                    title={swatch}
                    onClick={() => onColor(project.id, swatch)}
                  ><i /><span className="pe-check">✓</span></button>
                ))}
              </div>
              <div className="pe-hexrow">
                <i className="pe-hexdot" />
                <input
                  className="pe-hexinput"
                  value={hex}
                  maxLength={7}
                  spellCheck={false}
                  aria-label="hex 颜色"
                  onChange={(event) => setHex(event.target.value)}
                  onBlur={commitHex}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitHex(); } }}
                />
                <button type="button" className={`pe-follow ${follow ? "is-on" : ""}`} aria-pressed={follow} onClick={() => onColor(project.id, null)}><i className="pe-follow-dot" />跟随分类</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="pe-hint">点节点只高亮，不跳转；点节点左侧色点换颜色；拖 project 到某事项上 = 它做 chain 起点。</div>
      <div className="ms-row-btns">
        <button type="button" className="danger-button" onClick={() => onDelete(project.id)}><Trash2 size={14} /> 删除 project</button>
        <span className="ms-right">
          <button type="button" className="secondary-button" onClick={onDone}>取消</button>
          <button type="button" className="primary-button" onClick={save}>保存</button>
        </span>
      </div>
    </div>
  );
}
