import { describe, it, expect } from "vitest";
import { decideScroll, decideBadge } from "./scrollDecision.js";

describe("decideScroll", () => {
  describe("initial-load window", () => {
    it("scrolls instantly on the very first commit (stale scroll position)", () => {
      expect(
        decideScroll({
          isInitialLoad: true,
          initialScrollDone: false,
          arrayGrew: true,
          tailChanged: true,
          isOwnMessage: false,
          isAtBottom: false,
        }),
      ).toBe("instant-bottom");
    });

    it("scrolls instantly on the first commit even when the array size did not change", () => {
      expect(
        decideScroll({
          isInitialLoad: true,
          initialScrollDone: false,
          arrayGrew: false,
          tailChanged: true,
          isOwnMessage: false,
          isAtBottom: false,
        }),
      ).toBe("instant-bottom");
    });

    it("scrolls instantly on a subsequent commit when older rows were prepended (array grew, user now in the middle)", () => {
      expect(
        decideScroll({
          isInitialLoad: true,
          initialScrollDone: true,
          arrayGrew: true,
          tailChanged: false,
          isOwnMessage: false,
          isAtBottom: false,
        }),
      ).toBe("instant-bottom");
    });

    it("scrolls instantly on a subsequent commit when newer rows were appended (array grew, tail changed)", () => {
      expect(
        decideScroll({
          isInitialLoad: true,
          initialScrollDone: true,
          arrayGrew: true,
          tailChanged: true,
          isOwnMessage: false,
          isAtBottom: true,
        }),
      ).toBe("instant-bottom");
    });

    it("does not scroll during initial load when only in-place fields changed (status / read receipt / etc.)", () => {
      expect(
        decideScroll({
          isInitialLoad: true,
          initialScrollDone: true,
          arrayGrew: false,
          tailChanged: false,
          isOwnMessage: false,
          isAtBottom: true,
        }),
      ).toBe("none");
    });
  });

  describe("post-initial-load (user is in normal mode)", () => {
    it("does not scroll on a status / read-receipt commit (tail unchanged)", () => {
      expect(
        decideScroll({
          isInitialLoad: false,
          initialScrollDone: true,
          arrayGrew: false,
          tailChanged: false,
          isOwnMessage: false,
          isAtBottom: true,
        }),
      ).toBe("none");
    });

    it("scrolls smoothly when the user sent the new tail message (regardless of scroll position)", () => {
      expect(
        decideScroll({
          isInitialLoad: false,
          initialScrollDone: true,
          arrayGrew: true,
          tailChanged: true,
          isOwnMessage: true,
          isAtBottom: false,
        }),
      ).toBe("smooth-bottom");
    });

    it("scrolls smoothly when a received message lands and the user is near the bottom", () => {
      expect(
        decideScroll({
          isInitialLoad: false,
          initialScrollDone: true,
          arrayGrew: true,
          tailChanged: true,
          isOwnMessage: false,
          isAtBottom: true,
        }),
      ).toBe("smooth-bottom");
    });

    it("does not scroll when a received message lands and the user is scrolled up (badge surfaces it instead)", () => {
      expect(
        decideScroll({
          isInitialLoad: false,
          initialScrollDone: true,
          arrayGrew: true,
          tailChanged: true,
          isOwnMessage: false,
          isAtBottom: false,
        }),
      ).toBe("none");
    });
  });
});

describe("decideBadge", () => {
  it("does not update during the initial-load window", () => {
    expect(
      decideBadge({
        isInitialLoad: true,
        tailChanged: true,
        isOwnMessage: false,
        isAtBottom: false,
      }),
    ).toBe("none");
  });

  it("does not update on a non-tail commit (status / read receipt)", () => {
    expect(
      decideBadge({
        isInitialLoad: false,
        tailChanged: false,
        isOwnMessage: false,
        isAtBottom: true,
      }),
    ).toBe("none");
  });

  it("resets when the user sent the new tail message", () => {
    expect(
      decideBadge({
        isInitialLoad: false,
        tailChanged: true,
        isOwnMessage: true,
        isAtBottom: false,
      }),
    ).toBe("reset");
  });

  it("resets when a received message lands and the user is near the bottom (auto-scroll handles it)", () => {
    expect(
      decideBadge({
        isInitialLoad: false,
        tailChanged: true,
        isOwnMessage: false,
        isAtBottom: true,
      }),
    ).toBe("reset");
  });

  it("increments when a received message lands and the user is scrolled up", () => {
    expect(
      decideBadge({
        isInitialLoad: false,
        tailChanged: true,
        isOwnMessage: false,
        isAtBottom: false,
      }),
    ).toBe("increment");
  });
});
