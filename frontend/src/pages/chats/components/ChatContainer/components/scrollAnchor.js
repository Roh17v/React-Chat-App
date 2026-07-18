/**
 * Pure helpers for preserving the user's scroll position when older
 * messages are prepended above the current viewport (the pagination
 * case). Anchoring to a specific message — instead of a height delta —
 * is robust against anything that changes the content height between
 * the moment we trigger pagination and the moment the new rows render
 * (the previous "top dots" indicator, an `applySubscriptionSnapshot`
 * prepending an offline backlog row, image lazy-load, etc.).
 */

/**
 * Compute the scrollTop adjustment needed to keep a captured anchor
 * message at the same viewport position after the message list grows
 * above it.
 *
 * The caller captures the anchor message's distance from the container's
 * content top BEFORE pagination (`oldAnchorViewportTop` =
 * `el.getBoundingClientRect().top - container.getBoundingClientRect().top`).
 * After pagination resolves and the new rows are in the DOM, the caller
 * measures the same anchor again (`newAnchorViewportTop`). If the anchor
 * shifted down (older rows prepended above it), the adjustment is
 * positive — we scroll the container down to compensate. If it shifted
 * up, the adjustment is negative.
 *
 * @param {number | null | undefined} oldAnchorViewportTop
 * @param {number | null | undefined} newAnchorViewportTop
 * @returns {number}
 */
export const computeAnchorAdjustment = (oldAnchorViewportTop, newAnchorViewportTop) => {
  if (oldAnchorViewportTop == null || newAnchorViewportTop == null) return 0;
  return newAnchorViewportTop - oldAnchorViewportTop;
};
