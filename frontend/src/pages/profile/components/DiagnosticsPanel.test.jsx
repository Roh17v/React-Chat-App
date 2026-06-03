// @ts-nocheck
/**
 * DiagnosticsPanel — unit tests.
 *
 * Validates Requirements 14.1, 14.2, 14.3, 14.4:
 *   14.1  Panel renders live diagnostics data from getDiagnostics().snapshot()
 *   14.2  "Copy diagnostics" button calls getDiagnostics().toClipboardText()
 *         and writes the result to the clipboard.
 *   14.3  Events are rendered in the scrollable list.
 *   14.4  No message content / secrets are rendered (the module enforces this;
 *         the UI just renders what the snapshot exposes).
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Hoisted mutable state — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------

const { mockDiagnostics, mockSnapshot, storeState } = vi.hoisted(() => {
  const mockSnapshot = {
    events: [],
    schemaVersion: 3,
    localEncryption: "secure",
    mediaCacheSize: 12345678,
    outboundQueueLength: 5,
  };

  const mockDiagnostics = {
    snapshot: vi.fn(() => ({ ...mockSnapshot, events: [...mockSnapshot.events] })),
    toClipboardText: vi.fn(() => "schemaVersion\t3\nlocalEncryption\tsecure\n"),
  };

  const storeState = { localEncryption: "secure" };

  return { mockDiagnostics, mockSnapshot, storeState };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/offline/utils/Diagnostics", () => ({
  getDiagnostics: () => mockDiagnostics,
}));

vi.mock("@/store", () => ({
  default: vi.fn((selector) => selector(storeState)),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import component under test (after mocks are declared)
// ---------------------------------------------------------------------------

import DiagnosticsPanel from "./DiagnosticsPanel";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Navigator clipboard mock
// ---------------------------------------------------------------------------

const clipboardMock = {
  writeText: vi.fn(async (text) => text),
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let container;
let root;

function mountPanel(onBack = vi.fn()) {
  act(() => {
    root.render(<DiagnosticsPanel onBack={onBack} />);
  });
}

function unmount() {
  act(() => {
    root.unmount();
  });
}

function getTextContent() {
  return container.textContent || "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiagnosticsPanel", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // Reset state to defaults
    storeState.localEncryption = "secure";
    mockSnapshot.schemaVersion = 3;
    mockSnapshot.mediaCacheSize = 12345678;
    mockSnapshot.outboundQueueLength = 5;
    mockSnapshot.events = [];

    mockDiagnostics.snapshot.mockImplementation(() => ({
      ...mockSnapshot,
      events: [...mockSnapshot.events],
    }));
    mockDiagnostics.toClipboardText.mockReturnValue(
      "schemaVersion\t3\nlocalEncryption\tsecure\n"
    );

    Object.defineProperty(navigator, "clipboard", {
      value: clipboardMock,
      writable: true,
      configurable: true,
    });
    clipboardMock.writeText.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    unmount();
    document.body.removeChild(container);
  });

  // Req 14.1 — panel shows snapshot data
  it("renders schemaVersion from snapshot", () => {
    mountPanel();
    expect(getTextContent()).toContain("3");
  });

  it("renders outboundQueueLength from snapshot", () => {
    mountPanel();
    expect(getTextContent()).toContain("5");
  });

  it("renders mediaCacheSize as human-readable bytes", () => {
    mountPanel();
    // 12345678 bytes → ~11.8 MB
    expect(getTextContent()).toContain("MB");
  });

  it("renders localEncryption status from store", () => {
    mountPanel();
    expect(getTextContent()).toContain("secure");
  });

  // Req 10.4 — shows warning banner when localEncryption is "none"
  it("shows encryption warning banner when localEncryption is 'none'", () => {
    storeState.localEncryption = "none";
    mountPanel();
    expect(getTextContent()).toContain("not encrypted");
  });

  it("does NOT show encryption warning banner when localEncryption is 'secure'", () => {
    storeState.localEncryption = "secure";
    mountPanel();
    expect(getTextContent()).not.toContain("not encrypted");
  });

  // Req 14.3 — ring-buffer events are rendered
  it("shows 'No events' message when event list is empty", () => {
    mockSnapshot.events = [];
    mountPanel();
    expect(getTextContent()).toContain("No events");
  });

  it("renders events from snapshot in the event log", () => {
    mockSnapshot.events = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        category: "boot",
        code: "BOOT_OK",
        outcome: "ok",
        durationMs: 42,
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        category: "migration",
        code: "MIG_001",
        outcome: "warn",
      },
    ];
    mountPanel();
    const text = getTextContent();
    expect(text).toContain("BOOT_OK");
    expect(text).toContain("MIG_001");
    expect(text).toContain("boot");
    expect(text).toContain("migration");
  });

  it("shows the correct event count", () => {
    mockSnapshot.events = [
      { ts: "t", category: "boot", code: "X", outcome: "ok" },
      { ts: "t", category: "live", code: "Y", outcome: "ok" },
    ];
    mountPanel();
    expect(getTextContent()).toContain("2 events");
  });

  // Req 14.2 — "Copy diagnostics" button writes to clipboard and toasts
  it("calls getDiagnostics().toClipboardText() and writes to clipboard on copy", async () => {
    mountPanel();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent.includes("Copy diagnostics")
    );
    expect(btn).toBeTruthy();

    await act(async () => {
      btn.click();
    });

    expect(mockDiagnostics.toClipboardText).toHaveBeenCalled();
    expect(clipboardMock.writeText).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it("shows error toast when clipboard write fails", async () => {
    clipboardMock.writeText.mockRejectedValueOnce(new Error("denied"));
    mountPanel();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent.includes("Copy diagnostics")
    );

    await act(async () => {
      btn.click();
    });

    expect(toast.error).toHaveBeenCalled();
  });

  // Back navigation
  it("calls onBack when the back button is clicked", () => {
    const onBack = vi.fn();
    mountPanel(onBack);
    const backBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent.includes("Back to profile")
    );
    expect(backBtn).toBeTruthy();
    act(() => {
      backBtn.click();
    });
    expect(onBack).toHaveBeenCalled();
  });

  // Req 14.4 — privacy note is visible
  it("displays privacy disclaimer about no message content or auth tokens", () => {
    mountPanel();
    const text = getTextContent();
    expect(text).toContain("Message content");
    expect(text).toContain("auth tokens are never included");
  });
});
