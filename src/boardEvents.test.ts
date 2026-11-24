import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONAL_TAG,
  FAMS_LIGHT,
  GREY_INK,
  PALETTE,
  barHeight,
  canLink,
  categoryColor,
  chainOf,
  eventColor,
  familyColor,
  ganttRows,
  orderedProjects,
  projectColor,
  rowOfEvent,
  withFamily,
  type BoardEvent,
  type Project,
} from "./boardEvents";

function event(id: string, date: string, extra: Partial<BoardEvent> = {}): BoardEvent {
  return {
    id,
    title: id,
    note: "",
    shape: "point",
    date,
    dateEst: false,
    end: null,
    endEst: false,
    time: null,
    tags: [],
    next: null,
    remind: { onDay: true, daysBefore: [] },
    done: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function project(tag: string, head: string | null, priority = 5, color: string | null = null): Project {
  return { id: tag, tag, head, priority, color, note: "", updatedAt: 1 };
}

const FAMS = ["audit", "auction", "agent"];

describe("chains", () => {
  it("walks next until it ends or loops", () => {
    const events = [event("a", "2027-01-01", { next: "b" }), event("b", "2027-02-01", { next: "c" }), event("c", "2027-03-01", { next: "a" })];
    expect(chainOf(project("audit/平台", "a"), events)).toEqual(["a", "b", "c"]);
    expect(chainOf(project("audit/平台", null), events)).toEqual([]);
  });

  it("greys out the next options that would close a loop", () => {
    const events = [event("a", "2027-01-01", { next: "b" }), event("b", "2027-02-01"), event("c", "2027-03-01")];
    expect(canLink("a", "c", events)).toBe(true);
    expect(canLink("b", "a", events)).toBe(false);
    expect(canLink("a", "a", events)).toBe(false);
  });
});

describe("colours", () => {
  const projects = [project("audit/平台", "a"), project("audit/推荐", "b"), project("audit/第三个", "c"), project("audit/第四个", "d")];

  it("cycles the three sub-colours inside a category", () => {
    expect(familyColor(projects[0], projects, FAMS)).toBe(FAMS_LIGHT[0][0]);
    expect(familyColor(projects[1], projects, FAMS)).toBe(FAMS_LIGHT[0][1]);
    expect(familyColor(projects[2], projects, FAMS)).toBe(FAMS_LIGHT[0][2]);
    expect(familyColor(projects[3], projects, FAMS)).toBe(FAMS_LIGHT[0][0]);
  });

  it("appends a new category after the known ones and keeps the colour it got", () => {
    const saved = withFamily(FAMS, "期刊");
    expect(saved).toEqual([...FAMS, "期刊"]);
    expect(withFamily(FAMS, "audit")).toBe(FAMS);
    expect(categoryColor("期刊", projects, saved)).toBe(FAMS_LIGHT[3][0]);
    // 删掉中间的分类，后面的分类不换色
    expect(categoryColor("agent", projects, ["audit", "agent"])).toBe(FAMS_LIGHT[1][0]);
    expect(categoryColor("audit", projects, ["期刊", "audit"])).toBe(FAMS_LIGHT[1][0]);
  });

  it("an explicit colour wins over the family", () => {
    expect(projectColor(project("audit/平台", null, 5, "#123456"), projects, FAMS)).toBe("#123456");
    expect(PALETTE).toHaveLength(12);
  });

  it("an event off every chain is grey; a project's own event takes its colour", () => {
    const events = [event("a", "2027-01-01", { next: "b", tags: ["NLP/ACL"] }), event("b", "2027-02-01", { tags: ["NLP/EMNLP"] })];
    const own = event("own", "2027-03-01", { tags: ["auction/拍卖"] });
    const lonely = event("lonely", "2027-04-01");
    const auction = project("auction/拍卖", "a");
    expect(eventColor(events[0], events, [...projects, auction], FAMS)).toBe(projectColor(projects[0], [...projects, auction], FAMS));
    expect(eventColor(events[1], events, [...projects, auction], FAMS)).toBe(projectColor(projects[0], [...projects, auction], FAMS));
    expect(eventColor(own, events, [...projects, auction], FAMS)).toBe(projectColor(auction, [...projects, auction], FAMS));
    expect(eventColor(lonely, events, [...projects, auction], FAMS)).not.toBe(GREY_INK);
  });
});

describe("ordering", () => {
  it("sorts by family order, then priority descending, then array order", () => {
    const projects = [
      project("auction/低", null, 1),
      project("audit/甲", null, 3),
      project("audit/乙", null, 7),
      project("audit/丙", null, 3),
    ];
    expect(orderedProjects(projects, FAMS).map((item) => item.tag)).toEqual(["audit/乙", "audit/甲", "audit/丙", "auction/低"]);
  });
});

describe("gantt rows", () => {
  // a → b：NL/ACL 那行整行搬进 platform 组；c 在另一个 track
  const events = [
    event("a", "2027-01-01", { tags: ["NLP/ACL"], next: "b" }),
    event("b", "2027-02-01", { tags: ["NLP/EMNLP"] }),
    event("c", "2027-03-01", { tags: ["ECON/EC"] }),
    event("own", "2027-04-01", { tags: ["audit/平台"] }),
    event("loose", "2027-05-01"),
    event("m1", "2027-06-01", { tags: [DEFAULT_PERSONAL_TAG] }),
  ];
  const projects = [project("audit/平台", "a"), project("auction/拍卖", "own")];

  it("moves a whole venue row into the project group and sinks the rest grey", () => {
    const rows = ganttRows(events, projects, FAMS);
    const shape = rows.map((row) => (row.kind === "band" ? `#${row.label}` : row.kind === "project" ? `>${row.project.tag}` : row.parentProject ? `  ${row.key}` : `  ${row.key}(grey)`));
    expect(shape).toEqual([
      "#audit",
      ">audit/平台",
      "  NLP/ACL",
      "  NLP/EMNLP",
      "#auction",
      ">auction/拍卖",
      "#ECON",
      "  ECON/EC(grey)",
      `#${"个人事项"}`,
      `  ${DEFAULT_PERSONAL_TAG}(grey)`,
    ]);
    const acl = rows.find((row) => row.kind === "venue" && row.key === "NLP/ACL")!;
    expect(rowOfEvent(rows, events[0], projects)).toBe(acl);
    // project 自己的事项画在自己那一行，即使它在另一条 chain 上
    expect(rowOfEvent(rows, events[3], projects)).toBe(rows.find((row) => row.kind === "project" && row.project.id === "audit/平台"));
    expect(rowOfEvent(rows, events[4], projects)).toBeNull();
  });

  it("a venue shared by two projects appears once, under the earlier group", () => {
    const shared = [{ ...project("audit/平台", "a") }, project("audit/推荐", "a", 1)];
    const rows = ganttRows(events, shared, FAMS);
    expect(rows.filter((row) => row.kind === "venue" && row.key === "NLP/ACL")).toHaveLength(1);
    const acl = rows.find((row) => row.kind === "venue" && row.key === "NLP/ACL");
    expect(acl?.kind === "venue" && acl.parentProject).toBe("audit/平台");
  });

  it("collapsing a project hides its venue rows and recomputes y", () => {
    const open = ganttRows(events, projects, FAMS);
    const folded = ganttRows(events, projects, FAMS, new Set(["audit/平台"]));
    const hidden = open.filter((row) => row.kind === "venue" && row.parentProject === "audit/平台");
    expect(hidden).toHaveLength(2);
    expect(folded.some((row) => row.kind === "venue" && row.parentProject === "audit/平台")).toBe(false);
    expect(folded.length).toBe(open.length - hidden.length);
    const saved = hidden.reduce((sum, row) => sum + row.height, 0);
    expect(folded.find((row) => row.kind === "band" && row.label === "auction")!.y).toBe(open.find((row) => row.kind === "band" && row.label === "auction")!.y - saved);
  });

  it("gives a shared bar its (n+1)/2 height", () => {
    expect(barHeight(1)).toBe(15);
    expect(barHeight(2)).toBe(22.5);
    expect(barHeight(3)).toBe(30);
    const shared = [project("audit/平台", "c"), project("auction/拍卖", "c")];
    const row = ganttRows(events, shared, FAMS).find((item) => item.kind === "venue" && item.key === "ECON/EC");
    expect(row?.height).toBe(Math.max(34, barHeight(2) + 24));
  });

  it("leaves untagged events off the gantt", () => {
    const rows = ganttRows([event("loose", "2027-05-01")], [], FAMS);
    expect(rows).toEqual([]);
  });
});
