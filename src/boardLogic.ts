import type {
  AppSettings,
  ContainerId,
  Habit,
  PeriodId,
  PeriodSetting,
  Placement,
} from "./types";

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function cyclicDistance(from: number, to: number): number {
  return (to - from + 24) % 24;
}

export function periodForHour(hour: number, periods: PeriodSetting[]): PeriodId {
  if (hour < 0 || hour > 23 || periods.length === 0) {
    throw new Error("Invalid hour or empty period configuration");
  }

  return periods.reduce((closest, candidate) => {
    const closestDistance = cyclicDistance(closest.startHour, hour);
    const candidateDistance = cyclicDistance(candidate.startHour, hour);
    return candidateDistance < closestDistance ? candidate : closest;
  }).id;
}

export function hoursForPeriod(periodId: PeriodId, settings: AppSettings): number[] {
  const period = settings.periods.find((item) => item.id === periodId);
  if (!period) return [];

  return Array.from({ length: 24 }, (_, index) => (period.startHour + index) % 24).filter(
    (hour) => periodForHour(hour, settings.periods) === periodId,
  );
}

export function orderedPeriods(settings: AppSettings): PeriodSetting[] {
  const morning = settings.periods.find((period) => period.id === "morning");
  const start = morning?.startHour ?? 0;
  return [...settings.periods].sort(
    (left, right) => cyclicDistance(start, left.startHour) - cyclicDistance(start, right.startHour),
  );
}

export function containerForPlacement(placement: Placement): ContainerId {
  return placement.kind === "hour"
    ? `hour:${placement.hour}`
    : `period:${placement.period}`;
}

export function placementForContainer(containerId: ContainerId): Placement {
  const [kind, value] = containerId.split(":");
  if (kind === "hour") return { kind: "hour", hour: Number(value) };
  return { kind: "period", period: value as PeriodId };
}

export function itemsInContainer(items: Habit[], containerId: ContainerId): Habit[] {
  return items
    .filter((item) => containerForPlacement(item.placement) === containerId)
    .sort((left, right) => left.order - right.order);
}

export function reindexItems(items: Habit[]): Habit[] {
  const grouped = new Map<ContainerId, Habit[]>();
  items.forEach((item) => {
    const container = containerForPlacement(item.placement);
    grouped.set(container, [...(grouped.get(container) ?? []), item]);
  });

  const orderById = new Map<string, number>();
  grouped.forEach((groupItems) => {
    groupItems
      .sort((left, right) => left.order - right.order)
      .forEach((item, index) => orderById.set(item.id, index));
  });

  return items.map((item) => ({ ...item, order: orderById.get(item.id) ?? item.order }));
}

export function masonryRowSpan(height: number, rowHeight = 1, gap = 7): number {
  if (!Number.isFinite(height) || height <= 0) return 1;
  return Math.max(1, Math.ceil((height + gap) / (rowHeight + gap)));
}

export function moveHabit(
  items: Habit[],
  activeId: string,
  targetContainer: ContainerId,
  overId?: string,
): Habit[] {
  const active = items.find((item) => item.id === activeId);
  if (!active) return items;

  const sourceContainer = containerForPlacement(active.placement);
  const sourceItems = itemsInContainer(items, sourceContainer).filter((item) => item.id !== activeId);
  const targetItems =
    sourceContainer === targetContainer
      ? sourceItems
      : itemsInContainer(items, targetContainer).filter((item) => item.id !== activeId);

  const overIndex = overId ? targetItems.findIndex((item) => item.id === overId) : -1;
  const insertAt = overIndex >= 0 ? overIndex : targetItems.length;
  targetItems.splice(insertAt, 0, {
    ...active,
    placement: placementForContainer(targetContainer),
    updatedAt: new Date().toISOString(),
  });

  const sourceOrder = new Map(sourceItems.map((item, index) => [item.id, index]));
  const targetOrder = new Map(targetItems.map((item, index) => [item.id, index]));

  return items.map((item) => {
    if (targetOrder.has(item.id)) {
      const movedItem = item.id === activeId ? targetItems[targetOrder.get(item.id)!] : item;
      return {
        ...movedItem,
        placement: placementForContainer(targetContainer),
        order: targetOrder.get(item.id)!,
      };
    }
    if (sourceOrder.has(item.id)) return { ...item, order: sourceOrder.get(item.id)! };
    return item;
  });
}

export function validatePeriodStarts(settings: AppSettings): string | null {
  const starts = settings.periods.map((period) => period.startHour);
  if (starts.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    return "所有时间分界必须是 0 到 23 的整点。";
  }
  if (new Set(starts).size !== starts.length) {
    return "四个时间段不能从同一个小时开始。";
  }
  return null;
}
