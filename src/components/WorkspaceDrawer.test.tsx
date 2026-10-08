// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceDrawer, type WorkspaceSection } from "./WorkspaceDrawer";

function NavigationHarness() {
  const [open, setOpen] = useState(true);
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("board");
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={triggerRef} type="button">β</button>
      <WorkspaceDrawer
        activeSection={activeSection}
        open={open}
        onOpenChange={setOpen}
        onSectionChange={setActiveSection}
        triggerRef={triggerRef}
      />
      <output>{activeSection}</output>
    </>
  );
}

describe("WorkspaceDrawer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<NavigationHarness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("marks the default time board and switches to Recall before closing", () => {
    const boardButton = host.querySelector<HTMLButtonElement>('[aria-current="page"]');
    expect(boardButton?.textContent).toContain("时间板");

    const recallButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".workspace-drawer-item"))
      .find((button) => button.textContent?.includes("回想"));
    act(() => recallButton?.click());

    expect(host.querySelector("output")?.textContent).toBe("recall");
    expect(host.querySelector(".workspace-drawer")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>("button")?.ownerDocument.activeElement).toBe(host.querySelector("button"));
  });

  it("closes on Escape and restores focus to the Beta trigger", () => {
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(host.querySelector(".workspace-drawer")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(host.querySelector("button"));
  });
});
