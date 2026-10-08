import {
  createEmptyCard,
  forgetting_curve,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type FSRSParameters,
} from "ts-fsrs";
import type {
  FsrsCardSnapshot,
  FsrsGrade,
  FsrsSchedulerSnapshot,
  RecallStatus,
  ReviewRecord,
} from "../../types";

export const FSRS_ALGORITHM = "ts-fsrs" as const;
export const FSRS_VERSION = "5.4.2" as const;
export const DEFAULT_DESIRED_RETENTION = 0.9;
export const DEFAULT_REFERENCE_STABILITY = 2;

export const DEFAULT_FSRS_PARAMETERS: FSRSParameters = generatorParameters({
  request_retention: DEFAULT_DESIRED_RETENTION,
  enable_fuzz: false,
});

const STATE_NAMES: Record<number, FsrsCardSnapshot["state"]> = {
  [State.New]: "New",
  [State.Learning]: "Learning",
  [State.Review]: "Review",
  [State.Relearning]: "Relearning",
};

const GRADE_RATINGS: Record<FsrsGrade, Rating> = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy,
};

export const STATUS_GRADE_DEFAULTS: Record<RecallStatus, FsrsGrade> = {
  wrong: "Again",
  omitted: "Again",
  incomplete: "Hard",
  misunderstood: "Hard",
  correct: "Good",
};

const GRADE_SEVERITY: Record<FsrsGrade, number> = { Again: 0, Hard: 1, Good: 2, Easy: 3 };
const STATUS_SEVERITY: Record<RecallStatus, number> = { wrong: 0, omitted: 1, misunderstood: 2, incomplete: 3, correct: 4 };

export function gradeForStatus(status: RecallStatus): FsrsGrade {
  return STATUS_GRADE_DEFAULTS[status];
}

export function serializeCard(card: Card): FsrsCardSnapshot {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastRetrievability: card.last_review ? 1 : 0,
    state: STATE_NAMES[card.state] ?? "New",
    ...(card.last_review ? { lastReview: card.last_review.toISOString() } : {}),
  };
}

export function deserializeCard(snapshot: FsrsCardSnapshot): Card {
  return {
    due: new Date(snapshot.due),
    stability: snapshot.stability,
    difficulty: snapshot.difficulty,
    elapsed_days: snapshot.elapsedDays,
    scheduled_days: snapshot.scheduledDays,
    learning_steps: snapshot.learningSteps,
    reps: snapshot.reps,
    lapses: snapshot.lapses,
    state: State[snapshot.state],
    ...(snapshot.lastReview ? { last_review: new Date(snapshot.lastReview) } : {}),
  };
}

function parametersFor(snapshot?: FsrsSchedulerSnapshot): FSRSParameters {
  return snapshot?.parameters ?? DEFAULT_FSRS_PARAMETERS;
}

export function emptyCardSnapshot(now: Date = new Date()): FsrsCardSnapshot {
  return serializeCard(createEmptyCard(now));
}

export function createSchedulerSnapshot(
  knowledgeId: string,
  pointIds: string[],
  now: Date = new Date(),
  desiredRetention = DEFAULT_DESIRED_RETENTION,
): FsrsSchedulerSnapshot {
  const parameters = generatorParameters({
    ...DEFAULT_FSRS_PARAMETERS,
    request_retention: desiredRetention,
  });
  return {
    schemaVersion: 1,
    knowledgeId,
    algorithm: FSRS_ALGORITHM,
    fsrsVersion: FSRS_VERSION,
    parameters,
    desiredRetention,
    cards: Object.fromEntries(pointIds.map((pointId) => [pointId, emptyCardSnapshot(now)])),
    updatedAt: now.toISOString(),
    migration: { complete: true, migratedAt: now.toISOString() },
  };
}

export function ensureSchedulerCards(
  snapshot: FsrsSchedulerSnapshot,
  pointIds: string[],
  now: Date = new Date(),
): FsrsSchedulerSnapshot {
  const cards = { ...snapshot.cards };
  pointIds.forEach((pointId) => {
    if (!cards[pointId]) cards[pointId] = emptyCardSnapshot(now);
  });
  return { ...snapshot, cards, updatedAt: now.toISOString() };
}

export function applyGrade(
  cardSnapshot: FsrsCardSnapshot,
  grade: FsrsGrade,
  reviewedAt: Date,
  parameters: FSRSParameters = DEFAULT_FSRS_PARAMETERS,
): { card: FsrsCardSnapshot; due: string; scheduledDays: number } {
  const scheduler = fsrs(parameters);
  const result = scheduler.next(deserializeCard(cardSnapshot), reviewedAt, GRADE_RATINGS[grade] as 1 | 2 | 3 | 4);
  const card = serializeCard(result.card);
  card.lastRetrievability = scheduler.get_retrievability(result.card, reviewedAt, false);
  return {
    card,
    due: result.card.due.toISOString(),
    scheduledDays: result.card.scheduled_days,
  };
}

export function retrievability(
  cardSnapshot: FsrsCardSnapshot,
  now: Date = new Date(),
  parameters: FSRSParameters = DEFAULT_FSRS_PARAMETERS,
): number {
  if (!cardSnapshot.lastReview || cardSnapshot.stability <= 0) return 0;
  return fsrs(parameters).get_retrievability(deserializeCard(cardSnapshot), now, false);
}

export function isAtOrBelowTarget(
  card: FsrsCardSnapshot | undefined,
  targetRetention: number,
  now: Date = new Date(),
  parameters: FSRSParameters = DEFAULT_FSRS_PARAMETERS,
): boolean {
  if (!card || !card.lastReview || card.stability <= 0) return true;
  return retrievability(card, now, parameters) <= targetRetention;
}

function reviewGrade(review: ReviewRecord): FsrsGrade {
  return review.grade ?? gradeForStatus(review.status);
}

function observationValue(status: RecallStatus): number {
  return { wrong: 0, omitted: 0, misunderstood: 0.25, incomplete: 0.5, correct: 1 }[status];
}

function validDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function timestamp(value: string): number {
  return validDate(value)?.getTime() ?? 0;
}

/** Returns the natural day in the user's local timezone, not a rolling 24-hour bucket. */
export function reviewDayKey(reviewOrDate: ReviewRecord | string | Date): string {
  const value = typeof reviewOrDate === "string" || reviewOrDate instanceof Date ? reviewOrDate : reviewOrDate.confirmedAt;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface DailyReviewEvent extends ReviewRecord {
  dayKey: string;
  rawReviewIds: string[];
}

function compareReviews(a: ReviewRecord, b: ReviewRecord): number {
  const grade = GRADE_SEVERITY[reviewGrade(b)] - GRADE_SEVERITY[reviewGrade(a)];
  if (grade !== 0) return grade;
  const status = STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status];
  if (status !== 0) return status;
  return timestamp(b.confirmedAt) - timestamp(a.confirmedAt);
}

/** Collapses raw confirmed records into one best result per knowledge and local natural day. */
export function mergeReviewsByKnowledgeDay(
  knowledgeId: string,
  pointIds: string[],
  reviews: ReviewRecord[],
): DailyReviewEvent[] {
  const allowed = new Set(pointIds);
  const groups = new Map<string, ReviewRecord[]>();
  for (const review of reviews) {
    if (review.knowledgeId !== knowledgeId) continue;
    if (review.pointId && !allowed.has(review.pointId)) continue;
    if (!validDate(review.confirmedAt)) continue;
    const dayKey = reviewDayKey(review);
    if (!dayKey) continue;
    const key = `${knowledgeId}|${dayKey}`;
    groups.set(key, [...(groups.get(key) ?? []), review]);
  }
  return [...groups.values()]
    .map((group) => {
      const best = [...group].sort(compareReviews)[0];
      const distinctPoints = new Set(group.map((review) => review.pointId ?? "__whole_knowledge__"));
      const appliesToWholeKnowledge = group.some((review) => !review.pointId) || distinctPoints.size > 1;
      return {
        ...best,
        grade: reviewGrade(best),
        pointId: appliesToWholeKnowledge ? undefined : best.pointId,
        dayKey: reviewDayKey(best),
        rawReviewIds: group.map((review) => review.reviewId),
      };
    })
    .sort((a, b) => timestamp(a.confirmedAt) - timestamp(b.confirmedAt));
}

export interface ReplayResult {
  snapshot: FsrsSchedulerSnapshot;
  migratedReviewIds: string[];
  skippedReviewIds: string[];
}

/** Rebuilds cards from confirmed daily events. Duplicate raw review IDs are ignored. */
export function replayReviewLog(
  knowledgeId: string,
  pointIds: string[],
  reviews: ReviewRecord[],
  options: { now?: Date; desiredRetention?: number; createdAt?: Date } = {},
): ReplayResult {
  const now = options.now ?? new Date();
  const knowledgeReviews = reviews.filter((review) => review.knowledgeId === knowledgeId);
  const skippedReviewIds: string[] = [];
  const seenIds = new Set<string>();
  const uniqueReviews: ReviewRecord[] = [];
  const allowed = new Set(pointIds);
  for (const review of knowledgeReviews) {
    if (seenIds.has(review.reviewId)) {
      skippedReviewIds.push(review.reviewId);
      continue;
    }
    seenIds.add(review.reviewId);
    if (review.pointId && !allowed.has(review.pointId)) {
      skippedReviewIds.push(review.reviewId);
      continue;
    }
    if (!validDate(review.confirmedAt)) {
      skippedReviewIds.push(review.reviewId);
      continue;
    }
    uniqueReviews.push(review);
  }
  const events = mergeReviewsByKnowledgeDay(knowledgeId, pointIds, uniqueReviews);
  const firstReviewAt = events[0] ? validDate(events[0].confirmedAt) : undefined;
  const snapshot = createSchedulerSnapshot(
    knowledgeId,
    pointIds,
    options.createdAt ?? firstReviewAt ?? now,
    options.desiredRetention ?? DEFAULT_DESIRED_RETENTION,
  );
  const cards = { ...snapshot.cards };
  const migratedReviewIds = uniqueReviews.filter((review) => !review.grade).map((review) => review.reviewId);
  for (const event of events) {
    const reviewedAt = validDate(event.confirmedAt)!;
    const targetPointIds = event.pointId ? [event.pointId] : pointIds;
    for (const pointId of targetPointIds) {
      const result = applyGrade(cards[pointId] ?? emptyCardSnapshot(reviewedAt), reviewGrade(event), reviewedAt, snapshot.parameters);
      cards[pointId] = result.card;
    }
  }
  return {
    snapshot: {
      ...snapshot,
      cards,
      updatedAt: now.toISOString(),
      migration: {
        complete: skippedReviewIds.length === 0,
        migratedAt: now.toISOString(),
        ...(skippedReviewIds.length > 0 ? { warning: `${skippedReviewIds.length} 条记录无法重放` } : {}),
      },
    },
    migratedReviewIds,
    skippedReviewIds,
  };
}

export function cardForPoint(snapshot: FsrsSchedulerSnapshot | undefined, pointId: string, now: Date = new Date()): FsrsCardSnapshot {
  return snapshot?.cards[pointId] ?? emptyCardSnapshot(now);
}

export function isDue(card: FsrsCardSnapshot | undefined, now: Date = new Date()): boolean {
  return !card || new Date(card.due).getTime() <= now.getTime();
}

export interface CurveObservation {
  dayKey: string;
  reviewId: string;
  rawReviewIds: string[];
  grade: FsrsGrade;
  status: RecallStatus;
  confirmedAt: string;
  value: number;
}

export interface CurvePoint {
  day: number;
  at: string;
  reference: number;
  model: number;
  observation?: CurveObservation;
}

export interface KnowledgeCurveOptions {
  now?: Date;
  days?: number;
  step?: number;
  startAt?: Date;
  /** The knowledge audit time used as the reference curve's true time origin. */
  createdAt?: Date;
  referenceStability?: number;
}

function observationFor(event: DailyReviewEvent): CurveObservation {
  return {
    dayKey: event.dayKey,
    reviewId: event.reviewId,
    rawReviewIds: event.rawReviewIds,
    grade: reviewGrade(event),
    status: event.status,
    confirmedAt: event.confirmedAt,
    value: observationValue(event.status),
  };
}

function referenceValue(day: number, stability: number): number {
  return forgetting_curve(DEFAULT_FSRS_PARAMETERS.w, Math.max(0, day), Math.max(0.01, stability));
}

function modelValue(
  cards: Record<string, FsrsCardSnapshot>,
  pointIds: string[],
  at: Date,
  referenceDay: number,
  referenceStability: number,
  parameters: FSRSParameters,
): number {
  if (pointIds.length === 0) return referenceValue(referenceDay, referenceStability);
  const values = pointIds.map((pointId) => {
    const card = cards[pointId];
    if (!card?.lastReview) return referenceValue(referenceDay, referenceStability);
    const elapsedDays = Math.max(0, (at.getTime() - new Date(card.lastReview).getTime()) / 86400000);
    return forgetting_curve(parameters.w, elapsedDays, Math.max(0.01, card.stability));
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildTimelineCurve(
  knowledgeId: string,
  pointIds: string[],
  reviews: ReviewRecord[],
  snapshot: FsrsSchedulerSnapshot | undefined,
  options: KnowledgeCurveOptions,
): CurvePoint[] {
  const now = options.now ?? new Date();
  const events = mergeReviewsByKnowledgeDay(knowledgeId, pointIds, reviews);
  const firstEventAt = events[0] ? validDate(events[0].confirmedAt) : undefined;
  const start = options.startAt ?? firstEventAt ?? options.createdAt ?? now;
  const horizon = Math.max(0, options.days ?? 30);
  const step = Math.max(0.25, options.step ?? 1);
  const end = new Date(start.getTime() + horizon * 86400000);
  const referenceOrigin = options.createdAt ?? start;
  const referenceStability = options.referenceStability ?? DEFAULT_REFERENCE_STABILITY;
  const parameters = parametersFor(snapshot);
  const cards: Record<string, FsrsCardSnapshot> = Object.fromEntries(pointIds.map((pointId) => [pointId, emptyCardSnapshot(start)]));

  function applyEvent(event: DailyReviewEvent) {
    const reviewedAt = validDate(event.confirmedAt)!;
    const targetPointIds = event.pointId ? [event.pointId] : pointIds;
    targetPointIds.forEach((pointId) => {
      const result = applyGrade(cards[pointId] ?? emptyCardSnapshot(reviewedAt), reviewGrade(event), reviewedAt, parameters);
      cards[pointId] = result.card;
    });
  }

  events.filter((event) => validDate(event.confirmedAt)!.getTime() < start.getTime()).forEach(applyEvent);
  const visibleEvents = events.filter((event) => {
    const at = validDate(event.confirmedAt)!.getTime();
    return at >= start.getTime() && at <= end.getTime();
  });
  const sampleTimes = new Set<number>();
  const sampleCount = Math.floor(horizon / step);
  for (let index = 0; index <= sampleCount; index += 1) sampleTimes.add(Math.min(horizon, index * step) * 86400000 + start.getTime());
  sampleTimes.add(end.getTime());
  const eventTimes = new Set(visibleEvents.map((event) => validDate(event.confirmedAt)!.getTime()));
  const times = [...new Set([...sampleTimes, ...eventTimes])].sort((a, b) => a - b);
  const points: CurvePoint[] = [];
  let eventIndex = 0;
  for (const timestamp of times) {
    const at = new Date(timestamp);
    const day = (timestamp - start.getTime()) / 86400000;
    const referenceDay = (timestamp - referenceOrigin.getTime()) / 86400000;
    const reference = referenceValue(referenceDay, referenceStability);
    const eventsAtTime: DailyReviewEvent[] = [];
    while (eventIndex < visibleEvents.length && validDate(visibleEvents[eventIndex].confirmedAt)!.getTime() === timestamp) {
      eventsAtTime.push(visibleEvents[eventIndex]);
      eventIndex += 1;
    }
    const before = modelValue(cards, pointIds, at, referenceDay, referenceStability, parameters);
    if (eventsAtTime.length === 0) {
      points.push({ day: Number(day.toFixed(6)), at: at.toISOString(), reference, model: before });
      continue;
    }
    points.push({ day: Number(day.toFixed(6)), at: at.toISOString(), reference, model: before });
    for (const event of eventsAtTime) {
      applyEvent(event);
      points.push({ day: Number(day.toFixed(6)), at: at.toISOString(), reference, model: modelValue(cards, pointIds, at, referenceDay, referenceStability, parameters), observation: observationFor(event) });
    }
  }
  return points;
}

/** Builds a curve for one checkpoint while preserving the shared date axis. */
export function buildCurve(
  pointId: string,
  reviews: ReviewRecord[],
  snapshot: FsrsSchedulerSnapshot | undefined,
  options: KnowledgeCurveOptions = {},
): CurvePoint[] {
  const knowledgeId = snapshot?.knowledgeId ?? reviews.find((review) => review.pointId === pointId || !review.pointId)?.knowledgeId ?? "curve-preview";
  return buildTimelineCurve(knowledgeId, [pointId], reviews, snapshot, options);
}

/** Aggregates all checkpoint cards into one knowledge-level curve. */
export function buildKnowledgeCurve(
  knowledgeId: string,
  pointIds: string[],
  reviews: ReviewRecord[],
  snapshot: FsrsSchedulerSnapshot | undefined,
  options: KnowledgeCurveOptions = {},
): CurvePoint[] {
  return buildTimelineCurve(knowledgeId, [...new Set(pointIds)].filter(Boolean), reviews, snapshot, options);
}

export function gradeLabel(grade: FsrsGrade): string {
  return { Again: "Again", Hard: "Hard", Good: "Good", Easy: "Easy" }[grade];
}
