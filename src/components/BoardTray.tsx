import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { orderedProjects, projectColor, type Project } from "../boardEvents";

/** Dropping a chip back here puts the project's chain head back to 未分配. */
export const TRAY_DROP = "tray";

function TrayChip({ project, projects, projectFamilies, dark, selected, onSelect }: {
  project: Project;
  projects: Project[];
  projectFamilies: string[];
  dark: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `project:${project.id}` });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className={`ms-proj ${project.head ? "" : "dim"} ${selected === project.id ? "is-sel" : ""} ${isDragging ? "is-dragging" : ""}`}
      style={{ background: projectColor(project, projects, projectFamilies, dark), transform: CSS.Translate.toString(transform) }}
      title={project.tag}
      onClick={() => onSelect(project.id)}
      {...listeners}
      {...attributes}
      aria-pressed={selected === project.id}
    >
      <span className="ms-grip" aria-hidden="true">⋮⋮</span>
      {project.tag.split("/").slice(1).join("/") || project.tag}
    </button>
  );
}

/**
 * The project tray above both new views. A chip is the project's chain head, or dim when it is back in
 * the tray; clicking one opens it in the right panel, dragging one onto a gantt event makes it `head`.
 */
export function ProjectTray({ projects, projectFamilies, dark, hint, selected, onSelect }: {
  projects: Project[];
  projectFamilies: string[];
  dark: boolean;
  hint: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const tray = useDroppable({ id: TRAY_DROP });
  return (
    <div className={`ms-tray ${tray.isOver ? "is-drop" : ""}`} role="group" aria-label="project" ref={tray.setNodeRef}>
      <span className="ms-lbl">project</span>
      {orderedProjects(projects, projectFamilies).map((project) => (
        <TrayChip key={project.id} project={project} projects={projects} projectFamilies={projectFamilies} dark={dark} selected={selected} onSelect={onSelect} />
      ))}
      <span className="ms-lbl ms-tray-hint">{hint}</span>
    </div>
  );
}

/** What the shapes on the board mean; small enough to keep above the grid. */
export function BoardLegend() {
  return (
    <div className="ms-legend" aria-hidden="true">
      <span><i className="ms-lg-dia" /> span 截止 OFFICIAL</span>
      <span><i className="ms-lg-dia-est" /> 截止 EST（~）</span>
      <span><i className="ms-lg-bar" /> 占用期（截止→通知）</span>
      <span><i className="ms-lg-est" /> 占用期 EST</span>
      <span><i className="ms-lg-pt" /> point 单点 due</span>
      <span><i className="ms-lg-line" /> chain：next 下一站</span>
      <span>灰 = 不在任何 project 的 chain 上</span>
    </div>
  );
}
