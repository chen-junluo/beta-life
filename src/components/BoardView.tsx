import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Clock3, GripVertical, Pencil, Plus, Quote, X } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  containerForPlacement,
  hourLabel,
  hoursForPeriod,
  itemsInContainer,
  masonryRowSpan,
  moveHabit,
  orderedPeriods,
} from "../boardLogic";
import { parseSimpleMarkdown, splitTags } from "../simpleMarkdown";
import type {
  AppSettings,
  BoardViewMode,
  ContainerId,
  Habit,
  PeriodSetting,
} from "../types";

interface BoardViewProps {
  items: Habit[];
  settings: AppSettings;
  onItemsChange: (items: Habit[]) => void;
  onCreate: (container: ContainerId) => void;
  onEdit: (habit: Habit) => void;
  onSloganChange: (periodId: PeriodSetting["id"], slogan: string) => void;
  viewMode: BoardViewMode;
}

interface ContainerProps {
  id: ContainerId;
  items: Habit[];
  color: string;
  label: string;
  compact?: boolean;
  onCreate: (container: ContainerId) => void;
  onEdit: (habit: Habit) => void;
}

function fontSizeStyles(settings: AppSettings): CSSProperties {
  return {
    "--background-font-size": `${settings.appearance.backgroundFontSize}px`,
    "--slogan-font-size": `${settings.appearance.sloganFontSize}px`,
    "--habit-font-size": `${settings.appearance.habitFontSize}px`,
    "--tag-font-size": `${settings.appearance.tagFontSize}px`,
  } as CSSProperties;
}

const visualPointerCollision: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);

  const droppableIds = new Set(
    args.droppableContainers
      .filter((container) => !container.disabled)
      .map((container) => String(container.id)),
  );

  for (const element of document.elementsFromPoint(
    args.pointerCoordinates.x,
    args.pointerCoordinates.y,
  )) {
    const droppable = element.closest<HTMLElement>("[data-droppable-id]");
    const id = droppable?.dataset.droppableId;
    if (id && droppableIds.has(id)) return [{ id }];
  }

  return [];
};

function HabitTitle({ title }: { title: string }) {
  return (
    <div className="habit-card-title">
      {parseSimpleMarkdown(title).map((block, index) => {
        if (block.kind === "unordered-list") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
        }
        if (block.kind === "ordered-list") {
          return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>;
        }
        if (block.kind === "heading") {
          return <p key={index}><strong>{block.text}</strong></p>;
        }
        return (
          <p key={index}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function HabitTags({ value }: { value: string }) {
  const tags = splitTags(value);
  if (tags.length === 0) return null;
  return <div className="habit-tags">{tags.map((tag, index) => <span key={`${tag}-${index}`}>#{tag}</span>)}</div>;
}

function SortableHabitCard({ habit, onEdit }: { habit: Habit; onEdit: (habit: Habit) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: habit.id,
  });
  const cardRef = useRef<HTMLElement | null>(null);
  const [rowSpan, setRowSpan] = useState(1);
  const setCardRef = useCallback((node: HTMLElement | null) => {
    cardRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;

    const updateSpan = () => {
      const nextSpan = masonryRowSpan(node.getBoundingClientRect().height);
      setRowSpan((current) => current === nextSpan ? current : nextSpan);
    };
    updateSpan();
    const observer = new ResizeObserver(updateSpan);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.28 : 1,
    pointerEvents: isDragging ? "none" : undefined,
    gridRowEnd: `span ${rowSpan}`,
  };

  return (
    <article
      ref={setCardRef}
      style={style}
      className="habit-card"
      data-droppable-id={habit.id}
      onClick={() => onEdit(habit)}
    >
      <button
        className="drag-handle"
        aria-label={`拖动 ${habit.title}`}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} />
      </button>
      <div className="habit-card-copy">
        <HabitTitle title={habit.title} />
        <HabitTags value={habit.tags} />
      </div>
    </article>
  );
}

function HabitCardPreview({ habit, settings }: { habit: Habit; settings: AppSettings }) {
  return (
    <article className="habit-card habit-card-preview" style={fontSizeStyles(settings)}>
      <GripVertical size={15} />
      <div className="habit-card-copy">
        <HabitTitle title={habit.title} />
        <HabitTags value={habit.tags} />
      </div>
    </article>
  );
}

function SortableContainer({
  id,
  items,
  color,
  label,
  compact = false,
  onCreate,
  onEdit,
}: ContainerProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`sortable-container ${compact ? "period-dropzone" : "hour-dropzone"} ${
        isOver ? "is-over" : ""
      }`}
      style={{ "--period-color": color } as CSSProperties}
      data-container-id={id}
      data-droppable-id={id}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={rectSortingStrategy}
      >
        <div className="card-stack">
          {items.map((habit) => (
            <SortableHabitCard key={habit.id} habit={habit} onEdit={onEdit} />
          ))}
        </div>
      </SortableContext>
      <button className="inline-add" onClick={() => onCreate(id)} aria-label={`在${label}添加习惯`}>
        <Plus size={14} />
        <span>{items.length === 0 ? "添加" : "继续添加"}</span>
      </button>
    </div>
  );
}

function PeriodSlogan({
  period,
  onChange,
}: {
  period: PeriodSetting;
  onChange: (slogan: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(period.slogan);

  useEffect(() => {
    if (!editing) setDraft(period.slogan);
  }, [editing, period.slogan]);

  function save() {
    const slogan = draft.trim();
    onChange(slogan);
    setEditing(false);
  }

  if (editing) {
    return (
      <form className="slogan-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <textarea
          autoFocus
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
          }}
          placeholder="写下这个时段的 slogan（无需输入 >）"
          aria-label={`${period.label} slogan`}
        />
        <div>
          <button type="button" className="slogan-action" onClick={() => setEditing(false)} aria-label="取消编辑 slogan">
            <X size={13} />
          </button>
          <button type="submit" className="slogan-action primary" aria-label="保存 slogan">
            <Check size={13} />
          </button>
        </div>
      </form>
    );
  }

  if (!period.slogan) {
    return (
      <button className="slogan-empty" onClick={() => setEditing(true)}>
        <Quote size={13} /> 添加这个时段的 slogan
      </button>
    );
  }

  return (
    <div className="period-slogan">
      <blockquote>{period.slogan}</blockquote>
      <button className="slogan-action" onClick={() => setEditing(true)} aria-label="编辑 slogan">
        <Pencil size={12} />
      </button>
    </div>
  );
}

function PeriodGroup({
  period,
  settings,
  items,
  focused,
  onCreate,
  onEdit,
  onSloganChange,
}: {
  period: PeriodSetting;
  settings: AppSettings;
  items: Habit[];
  focused: boolean;
  onCreate: (container: ContainerId) => void;
  onEdit: (habit: Habit) => void;
  onSloganChange: (periodId: PeriodSetting["id"], slogan: string) => void;
}) {
  const hours = hoursForPeriod(period.id, settings);
  const periodContainer = `period:${period.id}` as ContainerId;
  const periodItems = itemsInContainer(items, periodContainer);

  return (
    <section
      className="period-group"
      style={{
        ...fontSizeStyles(settings),
        "--period-color": period.color,
        "--card-min-width": `${settings.appearance.cardMinWidth}px`,
      } as CSSProperties}
      data-period-id={period.id}
      data-layout={focused ? "focus" : "global"}
    >
      <header className="period-heading">
        <div>
          <span className="period-dot" />
          <strong>{period.label}</strong>
        </div>
        <span>
          {hourLabel(hours[0])}–{hourLabel((hours.at(-1)! + 1) % 24)}
        </span>
      </header>

      <PeriodSlogan period={period} onChange={(slogan) => onSloganChange(period.id, slogan)} />

      {focused ? (
        <div
          className="focused-hours-grid"
          style={{
            gridTemplateColumns: `repeat(${hours.length + 1}, minmax(0, 1fr))`,
          }}
        >
          <div className="focus-lane focus-anytime-lane">
            <div className="lane-label">
              <Clock3 size={14} />
              未定具体小时
            </div>
            <SortableContainer
              id={periodContainer}
              items={periodItems}
              color={period.color}
              label={`${period.label}未定小时区`}
              compact
              onCreate={onCreate}
              onEdit={onEdit}
            />
          </div>

          {hours.map((hour) => {
            const id = `hour:${hour}` as ContainerId;
            return (
              <div className="focus-lane" key={hour}>
                <div className="hour-heading">{hourLabel(hour)}</div>
                <SortableContainer
                  id={id}
                  items={itemsInContainer(items, id)}
                  color={period.color}
                  label={hourLabel(hour)}
                  onCreate={onCreate}
                  onEdit={onEdit}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="period-anytime">
            <div className="lane-label">
              <Clock3 size={14} />
              未定具体小时
            </div>
            <SortableContainer
              id={periodContainer}
              items={periodItems}
              color={period.color}
              label={`${period.label}未定小时区`}
              compact
              onCreate={onCreate}
              onEdit={onEdit}
            />
          </div>

          <div className="hours-list">
            {hours.map((hour) => {
              const id = `hour:${hour}` as ContainerId;
              return (
                <div className="hour-row" key={hour}>
                  <div className="hour-heading">{hourLabel(hour)}</div>
                  <SortableContainer
                    id={id}
                    items={itemsInContainer(items, id)}
                    color={period.color}
                    label={hourLabel(hour)}
                    onCreate={onCreate}
                    onEdit={onEdit}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function BoardView({
  items,
  settings,
  onItemsChange,
  onCreate,
  onEdit,
  onSloganChange,
  viewMode,
}: BoardViewProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const periods = useMemo(() => orderedPeriods(settings), [settings]);
  const visiblePeriods = viewMode === "global"
    ? periods
    : periods.filter((period) => period.id === viewMode);
  const activeHabit = activeId ? items.find((item) => item.id === activeId) : undefined;
  const layoutKey = [
    settings.appearance.cardMinWidth,
    settings.appearance.zoomPercent,
    settings.appearance.backgroundFontSize,
    settings.appearance.sloganFontSize,
    settings.appearance.habitFontSize,
    settings.appearance.tagFontSize,
    viewMode,
    ...settings.periods.flatMap((period) => [period.id, period.startHour]),
  ].join(":");

  function findContainer(id: string): ContainerId | undefined {
    if (id.startsWith("hour:") || id.startsWith("period:")) return id as ContainerId;
    const habit = items.find((item) => item.id === id);
    return habit ? containerForPlacement(habit.placement) : undefined;
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const draggedId = String(event.active.id);
    setActiveId(null);
    if (!event.over) return;
    const target = findContainer(String(event.over.id));
    if (!target) return;
    const overId = items.some((item) => item.id === String(event.over?.id))
      ? String(event.over.id)
      : undefined;
    const next = moveHabit(items, draggedId, target, overId);
    onItemsChange(next);
  }

  return (
    <DndContext
      key={layoutKey}
      sensors={sensors}
      collisionDetection={visualPointerCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      <div
        className="timeline-scroll"
        aria-label={viewMode === "global" ? "全局模式生活时间板" : "聚焦模式生活时间板"}
        data-view-mode={viewMode}
      >
        <div className={`timeline-canvas ${viewMode === "global" ? "global-mode" : "focus-mode"}`}>
          {visiblePeriods.map((period) => (
            <PeriodGroup
              key={period.id}
              period={period}
              settings={settings}
              items={items}
              focused={viewMode !== "global"}
              onCreate={onCreate}
              onEdit={onEdit}
              onSloganChange={onSloganChange}
            />
          ))}
        </div>
      </div>
      <DragOverlay style={{ pointerEvents: "none" }}>
        {activeHabit ? <HabitCardPreview habit={activeHabit} settings={settings} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
