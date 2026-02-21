/**
 * Detects whether a string contains only emoji characters (no text).
 * Returns { isEmojiOnly, emojiCount } for styling decisions.
 *
 * Uses the Unicode Emoji property via a broad regex that covers:
 * - Basic emoticons, symbols, dingbats
 * - Supplemental symbols (food, animals, flags, etc.)
 * - Skin tone modifiers, ZWJ sequences, keycap sequences
 * - Regional indicator (flag) pairs
 */

// Matches a single emoji (including compound sequences like 👨‍👩‍👧‍👦, 🏳️‍🌈, etc.)
const EMOJI_RE =
  /(?:\p{RI}\p{RI}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{RI}\p{RI}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*[\u{1F3FB}-\u{1F3FF}]?/gu;

/**
 * @param {string} text
 * @returns {{ isEmojiOnly: boolean, emojiCount: number, sizeClass: string }}
 */
export function analyzeEmoji(text) {
  if (!text || typeof text !== "string") {
    return { isEmojiOnly: false, emojiCount: 0, sizeClass: "text-sm" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { isEmojiOnly: false, emojiCount: 0, sizeClass: "text-sm" };
  }

  // Remove all emoji matches and whitespace — if nothing remains, it's emoji-only
  const withoutEmoji = trimmed.replace(EMOJI_RE, "").replace(/\s+/g, "");
  const isEmojiOnly = withoutEmoji.length === 0;

  if (!isEmojiOnly) {
    return { isEmojiOnly: false, emojiCount: 0, sizeClass: "text-sm" };
  }

  const matches = trimmed.match(EMOJI_RE);
  const emojiCount = matches ? matches.length : 0;

  // Size tiers matching WhatsApp behavior
  let sizeClass;
  if (emojiCount === 1) {
    sizeClass = "text-5xl";       // Single emoji — very large
  } else if (emojiCount === 2) {
    sizeClass = "text-4xl";       // Two emojis — large
  } else if (emojiCount === 3) {
    sizeClass = "text-3xl";       // Three emojis — medium-large
  } else if (emojiCount <= 6) {
    sizeClass = "text-2xl";       // 4-6 emojis — medium
  } else {
    sizeClass = "text-xl";        // 7+ emojis — slightly larger than normal
  }

  return { isEmojiOnly, emojiCount, sizeClass };
}
