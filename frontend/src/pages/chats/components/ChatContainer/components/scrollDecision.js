/**
 * Pure decision functions for MessageContainer's scroll + badge
 * behavior. Extracted so the entire chat-scroll policy is specified
 * in one testable place — the component's job is reduced to
 * gathering inputs (live scroll position, message array state) and
 * acting on the result (calling scrollToBottom, updating the
 * badge ref). The functions themselves have no DOM access, no refs,
 * no side effects.
 *
 * Two parallel decisions:
 *
 *   decideScroll  — should the view scroll, and how?
 *                   Returns "instant-bottom" (no animation, used
 *                   during the initial-load window where the chat
 *                   is still catching up), "smooth-bottom"
 *                   (animated, used post-load for new tail
 *                   messages the user wants to see), or "none".
 *
 *   decideBadge   — should the "X new messages" badge update?
 *                   Returns "reset" (clear the count, used when we
 *                   scrolled to the bottom), "increment" (the user
 *                   is scrolled up and a new tail message landed),
 *                   or "none".
 *
 * The two are computed from the same inputs and called in
 * sequence from the same effect.
 */

/**
 * @typedef {"instant-bottom" | "smooth-bottom" | "none"} ScrollMode
 * @typedef {"reset" | "increment" | "none"} BadgeMode
 */

/**
 * @typedef {object} ScrollInputs
 * @property {boolean} isInitialLoad     — true while the chat is in its
 *   initial-load window (between chat-open and the user scrolling up
 *   meaningfully out of the "near bottom" zone).
 * @property {boolean} initialScrollDone — true once the first chat-open
 *   scroll has fired for this session.
 * @property {boolean} arrayGrew         — true if the message array grew
 *   in size since the last commit (catches both newer rows appended and
 *   older rows prepended).
 * @property {boolean} tailChanged       — true if the tail message's id
 *   changed since the last commit (a new message at the end).
 * @property {boolean} isOwnMessage      — true if the new tail message
 *   was sent by the current user.
 * @property {boolean} isAtBottom        — live: true if the user's
 *   scroll position is within 150px of the bottom of the container.
 */

/**
 * Decide whether/how to scroll on a messages commit.
 *
 * Policy:
 *
 *   Initial-load window:
 *     - First commit (initialScrollDone=false): instant-bottom. The
 *       container's scroll position is stale (from the previous chat
 *       or 0 on fresh mount), so any "is the user near the bottom"
 *       check would lie. The user always wants to land at the tail
 *       on chat-open.
 *     - Subsequent commits (initialScrollDone=true): instant-bottom
 *       if the array grew (newer rows appended or older rows
 *       prepended — both mean the chat is still catching up and the
 *       user wants the tail). none if the array stayed the same
 *       size (in-place field updates only — no need to disturb the
 *       view).
 *
 *   Post-initial-load:
 *     - No tail change: none. Status updates, read receipts, etc.
 *       that don't move the tail are in-place.
 *     - Tail changed (a new message arrived at the end):
 *       - Own message: smooth-bottom. The user just sent it; they
 *         want to see it.
 *       - Other's message, user near bottom: smooth-bottom. They're
 *         following the conversation.
 *       - Other's message, user scrolled up: none. Don't yank them
 *         away from older messages; the badge will surface the new
 *         arrival.
 *
 * @param {ScrollInputs} input
 * @returns {ScrollMode}
 */
export const decideScroll = ({
  isInitialLoad,
  initialScrollDone,
  arrayGrew,
  tailChanged,
  isOwnMessage,
  isAtBottom,
}) => {
  if (isInitialLoad) {
    if (!initialScrollDone || arrayGrew) {
      return "instant-bottom";
    }
    return "none";
  }

  if (!tailChanged) {
    return "none";
  }

  if (isOwnMessage || isAtBottom) {
    return "smooth-bottom";
  }

  return "none";
};

/**
 * Decide whether/how to update the "X new messages" badge that
 * appears on the scroll-to-bottom button. Parallel to `decideScroll`
 * — same inputs, called from the same effect.
 *
 * Policy:
 *   - Initial-load window: none. The chat is still loading; the user
 *     is at the bottom; any new arrivals are part of the normal
 *     load sequence.
 *   - Post-initial-load:
 *     - No tail change: none. Status updates, read receipts, etc.
 *       don't contribute to the count.
 *     - Own message: reset. The user sent it; they know about it.
 *     - Other's message, user near bottom: reset. They're following
 *       the conversation; no need to surface a badge.
 *     - Other's message, user scrolled up: increment. Surface the
 *       new arrival as a badge.
 *
 * @param {ScrollInputs} input
 * @returns {BadgeMode}
 */
export const decideBadge = ({
  isInitialLoad,
  tailChanged,
  isOwnMessage,
  isAtBottom,
}) => {
  if (isInitialLoad) return "none";
  if (!tailChanged) return "none";
  if (isOwnMessage || isAtBottom) return "reset";
  return "increment";
};
