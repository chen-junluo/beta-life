import { describe, expect, it } from "vitest";
import type { BoardEvent } from "../boardEvents";
import { dueEventReminders, morningDigest, pruneFired } from "./eventReminders";

const make = (over: Partial<BoardEvent> = {}): BoardEvent => ({
  id: "e1",
  title: "ISR 投稿",
  note: "",
  shape: "point",
  date: "2026-11-24",
  dateEst: false,
  end: null,
  endEst: false,
  time: null,
  tags: ["个人事项/工作"],
  next: null,
  remind: { onDay: true, daysBefore: [] },
  done: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const at = (hour: number, minute = 0) => new Date(2026, 10, 24, hour, minute).getTime();
const today = "2026-11-24";
const keys = (due: Array<{ key: string }>) => due.map((item) => item.key);

describe("event reminders", () => {
  it("waits for the clock of a timed point", () => {
    const event = make({ time: "17:00" });
    expect(dueEventReminders([event], [], today, at(16, 59))).toEqual([]);
    expect(keys(dueEventReminders([event], [], today, at(17)))).toEqual([`e1:${today}:onDay`]);
  });

  it("fires a span and an untimed point from the start of the day", () => {
    const span = make({ id: "s", shape: "span", end: "2026-11-30" });
    expect(keys(dueEventReminders([span], [], today, at(9)))).toEqual([`s:${today}:onDay`]);
  });

  it("fires days-before reminders only on that day", () => {
    const event = make({ date: "2026-11-27", remind: { onDay: true, daysBefore: [3] } });
    expect(keys(dueEventReminders([event], [], today, at(9)))).toEqual([`e1:${today}:before3`]);
    expect(dueEventReminders([event], [], "2026-11-26", at(9))).toEqual([]);
    expect(keys(dueEventReminders([event], [], "2026-11-27", at(9)))).toEqual(["e1:2026-11-27:onDay"]);
  });

  it("does not repeat a key already shown", () => {
    const event = make({ time: "17:00" });
    expect(dueEventReminders([event], [`e1:${today}:onDay`], today, at(18))).toEqual([]);
  });

  it("skips done events", () => {
    const event = make({ time: "17:00", done: true });
    expect(dueEventReminders([event], [], today, at(18))).toEqual([]);
  });

  it("digests the next 7 days once, only near the morning start", () => {
    const todayEvent = make({ id: "a", date: today, time: "09:00" });
    const farEvent = make({ id: "b", date: "2026-12-20" });
    const from = at(6);
    expect(morningDigest([todayEvent, farEvent], [], today, from, at(5))).toBeNull();
    expect(morningDigest([todayEvent, farEvent], [], today, from, at(7))?.items.map((item) => item.id)).toEqual(["a"]);
    expect(morningDigest([todayEvent, farEvent], [], today, from, at(11))).toBeNull();
    expect(morningDigest([todayEvent], [`morning:${today}`], today, from, at(7))).toBeNull();
  });

  it("prunes keys from past days", () => {
    expect(pruneFired([`x:2026-11-23:onDay`, `y:${today}:onDay`, `morning:${today}`, "junk"], today))
      .toEqual([`y:${today}:onDay`, `morning:${today}`]);
  });
});
