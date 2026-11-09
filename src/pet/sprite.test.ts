// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpritePlayer, frameDelay, type PetManifest } from "./sprite";

const manifest = JSON.parse(readFileSync("public/assets/bebe/pet.json", "utf8")) as PetManifest;

describe("bebe sprite player", () => {
  let element: HTMLDivElement;
  let states: string[];
  let player: SpritePlayer;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement("div");
    states = [];
    player = new SpritePlayer(element, manifest, "/assets/bebe/", (state) => states.push(state));
  });

  afterEach(() => {
    player.stop();
    vi.useRealTimers();
  });

  it("sizes the strip from the manifest and steps 96px per frame", () => {
    player.play("alert");
    expect(element.style.backgroundImage).toBe('url("/assets/bebe/alert.png")');
    expect(element.style.backgroundSize).toBe("384px 128px");
    expect(element.style.backgroundPositionX).toBe("0px");
    vi.advanceTimersByTime(125);
    expect(element.style.backgroundPositionX).toBe("-96px");
  });

  it("holds idle's first frame for an extra 3s every round", () => {
    expect(frameDelay(manifest.states.idle, 0)).toBe(3250);
    expect(frameDelay(manifest.states.idle, 1)).toBe(250);
    player.play("idle");
    vi.advanceTimersByTime(3249);
    expect(element.style.backgroundPositionX).toBe("0px");
    vi.advanceTimersByTime(1 + 250 * 5);
    expect(element.style.backgroundPositionX).toBe("0px");
    vi.advanceTimersByTime(3249);
    expect(element.style.backgroundPositionX).toBe("0px");
    vi.advanceTimersByTime(1);
    expect(element.style.backgroundPositionX).toBe("-96px");
  });

  it("plays alert twice and happy once before returning to idle", () => {
    player.play("alert");
    vi.advanceTimersByTime(125 * 8 - 1);
    expect(player.state).toBe("alert");
    vi.advanceTimersByTime(1);
    expect(player.state).toBe("idle");

    player.play("happy");
    vi.advanceTimersByTime(125 * 4);
    expect(states).toEqual(["alert", "idle", "happy", "idle"]);
  });

  it("keeps looping states running", () => {
    player.play("sleep");
    vi.advanceTimersByTime(60_000);
    expect(player.state).toBe("sleep");
  });

  it("matches every strip file to its frame count", () => {
    for (const spec of Object.values(manifest.states)) {
      const png = readFileSync(`public/assets/bebe/${spec.file}`);
      expect(png.readUInt32BE(16)).toBe(spec.frames * manifest.cell.width);
      expect(png.readUInt32BE(20)).toBe(manifest.cell.height);
    }
  });
});
