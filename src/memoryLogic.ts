import { pinyin } from "pinyin-pro";
import type { EmotionType, LifeStage, MemoryMetadata } from "./types";

export const MEMORY_EMOTIONS: { value: EmotionType; label: string; color: string }[] = [
  { value: "nostalgic", label: "怀念", color: "#e9a568" },
  { value: "melancholic", label: "伤感", color: "#3b6dff" },
  { value: "excited", label: "兴奋", color: "#38bdf8" },
  { value: "calm", label: "平静", color: "#6ee7b7" },
  { value: "confused", label: "迷茫", color: "#9ca3af" },
  { value: "warm", label: "温暖", color: "#f97316" },
];

export function memoryStarSize(intensity: number, baseSize: number, intensityScale: number): number {
  return baseSize + intensityScale * ((intensity - 1) / 9);
}

const MEMORY_YEARS = MEMORY_EMOTIONS.map(({ value }) => value);

export interface EmotionYearTable {
  years: number[];
  counts: Record<EmotionType, number[]>;
  datedMemoryCount: number;
}

export interface SimilarMemoryGroups {
  sameLocation: MemoryMetadata[];
  sameEmotion: MemoryMetadata[];
  sameStage: MemoryMetadata[];
}

/** Split the display/storage string without changing the Memory.location contract. */
export function splitMemoryLocations(location: string): string[] {
  return [...new Set(location.split(/[,/、]/u).map((part) => part.trim()).filter(Boolean))];
}

export function memoryHasLocation(location: string, selected: string): boolean {
  return splitMemoryLocations(location).includes(selected);
}

function normalizeSongText(value: string): string[] {
  return [...value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "")];
}

const songPinyinCache = new Map<string, { initials: string; full: string } | null>();

/** Pinyin initials ("qlx") and full pinyin ("qilixiang") for titles that contain Chinese characters. */
function songPinyin(song: string): { initials: string; full: string } | null {
  if (!songPinyinCache.has(song)) {
    const text = normalizeSongText(song).join("");
    songPinyinCache.set(song, /\p{Script=Han}/u.test(text)
      ? {
        initials: pinyin(text, { pattern: "first", toneType: "none", type: "array" }).join(""),
        full: pinyin(text, { toneType: "none", type: "array" }).join(""),
      }
      : null);
  }
  return songPinyinCache.get(song) ?? null;
}

function contiguousScore(haystack: string[], needle: string[]): number | null {
  const at = haystack.join("").indexOf(needle.join(""));
  return at < 0 ? null : -[...haystack.join("").slice(0, at)].length * 10 - (haystack.length - needle.length);
}

function subsequenceScore(haystack: string[], needle: string[]): number | null {
  let first = -1;
  let last = -1;
  let matched = 0;
  for (let index = 0; index < haystack.length && matched < needle.length; index += 1) {
    if (haystack[index] !== needle[matched]) continue;
    if (first < 0) first = index;
    last = index;
    matched += 1;
  }
  return matched < needle.length ? null : -(last - first + 1 - needle.length) * 10 - first;
}

/**
 * Fuzzy-score a song title. Tiers, best first: contiguous title match, pinyin initials ("qlx"),
 * full pinyin ("qingtian"), then in-order characters ("夜星" → "夜空中最亮的星"). Null means no match.
 */
export function songMatchScore(song: string, query: string): number | null {
  const needle = normalizeSongText(query);
  if (needle.length === 0) return 0;
  const haystack = normalizeSongText(song);
  const romanized = songPinyin(song);
  const tiers: [number, number | null][] = [
    [1000, contiguousScore(haystack, needle)],
    [800, romanized ? contiguousScore([...romanized.initials], needle) : null],
    [700, romanized ? contiguousScore([...romanized.full], needle) : null],
    [500, subsequenceScore(haystack, needle)],
  ];
  const hit = tiers.find(([, score]) => score !== null);
  return hit ? hit[0] + (hit[1] ?? 0) : null;
}

/** Match a song title against a partial, case-insensitive fuzzy query. */
export function matchesSongQuery(song: string, query: string): boolean {
  return songMatchScore(song, query) !== null;
}

export function memoryYear(date: string): number | null {
  const quarter = date.match(/^(\d{4})Q([1-4])$/i);
  if (quarter) return Number(quarter[1]);

  const yearFirst = date.match(/^(\d{4})(?:[-/.]\d{1,2}(?:[-/.]\d{1,2})?)?/);
  if (yearFirst) return Number(yearFirst[1]);

  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) && /^\d{4}/.test(date) ? year : null;
}

function stageYear(date: string): number | null {
  const match = date.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function buildEmotionYearTable(memories: MemoryMetadata[], stages: LifeStage[]): EmotionYearTable {
  const datedYears = memories.map((memory) => memoryYear(memory.date)).filter((year): year is number => year !== null);
  const stageYears = stages.flatMap((stage) => [stageYear(stage.start), stageYear(stage.end)]).filter((year): year is number => year !== null);
  const yearsInRange = [...datedYears, ...stageYears];
  const firstYear = yearsInRange.length > 0 ? Math.min(...yearsInRange) : 2007;
  const lastYear = yearsInRange.length > 0 ? Math.max(...yearsInRange) : 2027;
  const years = Array.from({ length: Math.max(1, lastYear - firstYear + 1) }, (_, index) => firstYear + index);
  const counts = Object.fromEntries(MEMORY_YEARS.map((emotion) => [emotion, years.map(() => 0)])) as Record<EmotionType, number[]>;
  let datedMemoryCount = 0;

  memories.forEach((memory) => {
    const year = memoryYear(memory.date);
    const index = year === null ? -1 : year - firstYear;
    if (index < 0 || index >= years.length) return;
    const row = counts[memory.emotion.type];
    if (row) {
      row[index] += 1;
      datedMemoryCount += 1;
    }
  });

  return { years, counts, datedMemoryCount };
}

export function getSimilarMemoryGroups(
  filteredMemories: MemoryMetadata[],
  selected: Pick<MemoryMetadata, "song" | "stage" | "location" | "emotion">,
): SimilarMemoryGroups {
  const similar = filteredMemories.filter((memory) => memory.song !== selected.song);
  return {
    sameLocation: similar.filter((memory) => {
      const selectedLocations = splitMemoryLocations(selected.location);
      return splitMemoryLocations(memory.location).some((location) => selectedLocations.includes(location));
    }).slice(0, 5),
    sameEmotion: similar.filter((memory) => memory.emotion.type === selected.emotion.type).slice(0, 5),
    sameStage: similar.filter((memory) => memory.stage === selected.stage).slice(0, 5),
  };
}
