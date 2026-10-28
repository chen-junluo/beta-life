// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeStage, Memory, MemoryMetadata } from "../types";
import { MemoryInsights } from "./MemoryInsights";

const stages: LifeStage[] = [{ name: "School", start: "2010-09", end: "2014-06" }];

function memory(id: string, patch: Partial<MemoryMetadata> = {}): MemoryMetadata {
  return {
    id,
    song: id,
    date: "2012Q2",
    stage: "School",
    location: "Home",
    emotion: { type: "calm", intensity: 5 },
    createdAt: "",
    updatedAt: "",
    ...patch,
  };
}

describe("MemoryInsights", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.restoreAllMocks();
  });

  it("shows V11 recommendation groups and opens a chosen memory", async () => {
    const selected = memory("selected", { song: "Selected" });
    const recommended = memory("recommended", { song: "Remember this" });
    const onMemoryClick = vi.fn();
    await act(async () => {
      root.render(
        <MemoryInsights
          memories={[selected, recommended]}
          lifeStages={stages}
          selectedMemory={{ ...selected, stage: selected.stage ?? "", content: "Full memory" } as Memory}
          onMemoryClick={onMemoryClick}
        />,
      );
    });

    expect(Array.from(host.querySelectorAll(".memory-similar-label")).map((label) => label.textContent)).toEqual([
      "同地点",
      "同情绪",
      "同阶段",
    ]);
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>(".memory-similar-link"))
      .find((candidate) => candidate.textContent === "Remember this");
    await act(async () => button?.click());
    expect(onMemoryClick).toHaveBeenCalledWith(recommended);
  });
});
