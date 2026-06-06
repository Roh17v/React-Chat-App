import { describe, it, expect } from "vitest";
import { computeAnchorAdjustment } from "./scrollAnchor.js";

describe("computeAnchorAdjustment", () => {
  it("returns a positive delta when the anchor shifted down (older rows prepended above)", () => {
    expect(computeAnchorAdjustment(100, 300)).toBe(200);
  });

  it("returns a negative delta when the anchor shifted up (newer rows inserted above)", () => {
    expect(computeAnchorAdjustment(200, 50)).toBe(-150);
  });

  it("returns zero when no anchor was captured (old input is null)", () => {
    expect(computeAnchorAdjustment(null, 250)).toBe(0);
  });

  it("returns zero when the anchor no longer exists in the new DOM (new input is null)", () => {
    expect(computeAnchorAdjustment(150, null)).toBe(0);
  });

  it("returns zero when both inputs are missing", () => {
    expect(computeAnchorAdjustment(null, null)).toBe(0);
  });

  it("returns zero when the anchor is at the same viewport position (no height change between rows)", () => {
    expect(computeAnchorAdjustment(123, 123)).toBe(0);
  });
});
