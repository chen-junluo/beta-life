/** Shape of `public/assets/bebe/pet.json`. */
export interface SpriteStateSpec {
  file: string;
  frames: number;
  fps: number;
  loop: boolean;
  playCount?: number;
  then?: string;
  holdFirstMs?: number;
  grabPoint?: [number, number];
}

export interface PetManifest {
  id: string;
  displayName: string;
  cell: { width: number; height: number; baseline: number };
  display: { width: number; height: number };
  states: Record<string, SpriteStateSpec>;
}

/** How long `frame` stays on screen; idle holds its first frame at the start of every round. */
export function frameDelay(spec: SpriteStateSpec, frame: number): number {
  const base = 1000 / spec.fps;
  return frame === 0 && spec.holdFirstMs ? base + spec.holdFirstMs : base;
}

/**
 * Drives one sprite element with setTimeout, writing background styles directly so React never
 * re-renders per frame. Non-looping states hand off to `then` after `playCount` rounds.
 */
export class SpritePlayer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: string | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly manifest: PetManifest,
    private readonly baseUrl: string,
    private readonly onStateChange: (state: string) => void = () => {},
  ) {}

  get state(): string | null {
    return this.current;
  }

  play(state: string): void {
    const spec = this.manifest.states[state];
    if (!spec) throw new Error(`Unknown pet state: ${state}`);
    this.stop();
    this.current = state;
    const { width, height } = this.manifest.display;
    this.element.style.backgroundImage = `url("${this.baseUrl}${spec.file}")`;
    this.element.style.backgroundSize = `${spec.frames * width}px ${height}px`;
    this.onStateChange(state);

    let frame = 0;
    let rounds = 0;
    const show = () => {
      this.element.style.backgroundPositionX = `${-frame * width}px`;
      this.timer = setTimeout(() => {
        frame += 1;
        if (frame === spec.frames) {
          frame = 0;
          rounds += 1;
          if (!spec.loop && rounds >= (spec.playCount ?? 1)) {
            this.play(spec.then ?? "idle");
            return;
          }
        }
        show();
      }, frameDelay(spec, frame));
    };
    show();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Preload every strip so switching states never flashes an empty frame. */
export function preloadStrips(manifest: PetManifest, baseUrl: string): Promise<void[]> {
  return Promise.all(
    Object.values(manifest.states).map(
      (spec) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = image.onerror = () => resolve();
          image.src = `${baseUrl}${spec.file}`;
        }),
    ),
  );
}
