import type { Habit, PeriodSetting } from "../types";

/** The main window owns the board; it pushes snapshots to the pet and applies the pet's requests. */
export const PET_READY = "pet://ready";
export const PET_BOARD = "pet://board";
export const PET_MARK_DONE = "pet://mark-done";

export interface PetBoardSnapshot {
  items: Habit[];
  periods: PeriodSetting[];
}

export interface PetMarkDone {
  habitId: string;
}
