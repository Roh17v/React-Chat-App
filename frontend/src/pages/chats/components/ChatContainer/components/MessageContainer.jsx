import useAppStore from "@/store";
import {
  CHANNEL_MESSAGES_ROUTE,
  HOST,
  MESSAGES_ROUTE,
  PRIVATE_CONTACT_MESSAGES_ROUTE,
  DELETE_FOR_ME_ROUTE,
  DELETE_FOR_EVERYONE_ROUTE,
  MARK_READ_ROUTE,
} from "@/utils/constants";
import moment from "moment";
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { MdFolderZip } from "react-icons/md";
import { IoArrowDownCircle, IoCloseSharp } from "react-icons/io5";
import { IoMdDoneAll } from "react-icons/io";
import { MdDone } from "react-icons/md";
import { ChevronDown, Loader2, Trash2, Ban, Copy } from "lucide-react";
import { RiReplyLine } from "react-icons/ri";
import { cn } from "@/lib/utils";
import { useSocket } from "@/context/SocketContext";
import { analyzeEmoji } from "@/utils/emojiUtils";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { getRepository } from "@/offline";
import { getSyncEngine } from "@/offline/sync/SyncEngine.js";
import { getOutboundQueue } from "@/offline/sync/OutboundQueue.js";
import { computeAnchorAdjustment } from "./scrollAnchor.js";
import { decideScroll, decideBadge } from "./scrollDecision.js";

/**
 * Defensive accessor for the SyncEngine singleton. The factory throws when
 * called before `OfflineProvider` has wired the engine — that's the case
 * during the first paint on cold-start. We swallow the error and return
 * `null` so callers can branch instead of crash-rendering.
 */
const tryGetSyncEngine = () => {
  try {
    const engine = getSyncEngine();
    return engine != null ? engine : null;
  } catch {
    return null;
  }
};

const URL_REGEX = /\b((?:https?:\/\/|www\.)[^\s<]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s<]*)?)/gi;
const NATIVE_NETWORK_PAGE_LIMIT = 50;
const WEB_NETWORK_PAGE_LIMIT = 20;

/**
 * Convert a `LocalMessage` row produced by the offline repository into the
 * server-shape this file (and the rest of the chat UI) expects.
 *
 * The repository's `getMessages` / `subscribeMessages` returns rows in
 * camelCase local-DB shape (`senderId`, `serverId`, `replyToJson`, …).
 * The UI was originally built around the server REST response (`_id`,
 * `sender`, `replyTo`, `fileMetadata`, …). Without conversion the store's
 * dedup-by-`_id` collapses every row into a single entry — which is the
 * "one message per chat" symptom we are fixing here.
 *
 * Tolerates an already-converted server-shape row by passing it through
 * unchanged (the live `addMessage` / `confirmMessage` flows still feed
 * the store with raw socket payloads, and the union of both paths is
 * present in `selectedChatMessages` during normal operation).
 *
 * @param {Record<string, any>} m
 * @returns {Record<string, any>}
 */
const toUiMessage = (m) => {
  if (m == null || typeof m !== "object") return m;
  // Already in server shape — repository rows always carry `senderId`,
  // server payloads use `sender`.
  if (m.sender !== undefined && m._id !== undefined) return m;

  // Stable identity for a local-sent message across the optimistic →
  // confirmed transition. The optimistic row written by `enqueueOutbound`
  // has `serverId = null` and `clientTempId = <uuid>`. After
  // `resolveAndApply` runs (either from the `receiveMessage` socket event
  // or the OutboundQueue's `markOutboundConfirmed`), the SAME local row
  // is updated in place — `client_temp_id` is preserved (the conflict
  // resolver's UPDATE does not touch it) and `server_id` transitions from
  // NULL to the real server id. If we derive the UI `_id` from
  // `serverId`, the React key for that bubble changes the moment the
  // server confirms, and `applySubscriptionSnapshot`'s id-keyed merge
  // treats the optimistic and confirmed versions as TWO different
  // messages — both stay in state, and the user sees the bubble twice
  // (one stuck on the optimistic "pending"/clock icon, one with the real
  // "sent"/"delivered" status). On chat-close+reopen, `getMessages(1)`
  // re-reads the local DB; the merge rebuilds state from scratch and only
  // the confirmed row is in the DB, so the duplicate vanishes — which
  // matches the user's report exactly.
  //
  // `clientTempId` is the natural stable id: it is generated when the
  // user sends, sent to the server, echoed back in `receiveMessage`,
  // preserved in the local row forever, and present on every local-sent
  // message regardless of confirmation state. For received messages
  // (from another user) `clientTempId` is null and we fall through to
  // `serverId` (the repo's `server_id` column) — same value the user
  // would have seen in a server-payload shape (`m._id`).
  const _id =
    typeof m._id === "string" && m._id.length > 0
      ? m._id
      : typeof m.clientTempId === "string" && m.clientTempId.length > 0
        ? m.clientTempId
        : typeof m.serverId === "string" && m.serverId.length > 0
          ? m.serverId
          : typeof m.id === "string"
            ? m.id
            : undefined;

  let fileMetadata = undefined;
  if (typeof m.fileMetadataJson === "string" && m.fileMetadataJson.length > 0) {
    try {
      fileMetadata = JSON.parse(m.fileMetadataJson);
    } catch {
      fileMetadata = {};
    }
  } else if (m.fileMetadata !== undefined) {
    fileMetadata = m.fileMetadata;
  }

  let replyTo = null;
  if (typeof m.replyToJson === "string" && m.replyToJson.length > 0) {
    try {
      replyTo = JSON.parse(m.replyToJson);
    } catch {
      replyTo = null;
    }
  } else if (m.replyTo !== undefined) {
    replyTo = m.replyTo;
  }

  return {
    ...m,
    _id,
    sender: m.sender !== undefined ? m.sender : m.senderId,
    receiver: m.receiver !== undefined ? m.receiver : m.receiverId,
    channelId: m.channelId !== undefined ? m.channelId : null,
    fileMetadata,
    replyTo,
    deletedForEveryone:
      typeof m.deletedForEveryone === "boolean"
        ? m.deletedForEveryone
        : Boolean(m.deletedForEveryone),
    deletedForMe:
      typeof m.deletedForMe === "boolean"
        ? m.deletedForMe
        : Boolean(m.deletedForMe),
    // Keep clientTempId visible to the dedup / confirm flows.
    clientTempId:
      m.clientTempId !== undefined && m.clientTempId !== null
        ? m.clientTempId
        : null,
  };
};

const trimTrailingPunctuation = (value) => {
  let url = value;
  let trailing = "";
  while (url && /[.,!?;:]/.test(url[url.length - 1])) {
    trailing = url[url.length - 1] + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
};

const toSafeHref = (rawUrl) => {
  const withProtocol =
    rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? rawUrl
      : `https://${rawUrl}`;
  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
};

const MessageContainer = () => {
  const scrollRef = useRef(null);
  const {
    selectedChatType,
    selectedChatData,
    user,
    selectedChatMessages,
    setSelectedChatData,
    setSelectedChatMessages,
    setIsDownloading,
    setFileDownloadingProgress,
    page,
    setPage,
    typingIndicators,
    clearTypingIndicatorsForChat,
    resetUnreadCount,
    setReplyToMessage,
    deleteMessageForMe,
    replaceWithDeletedPlaceholder,
    messageActionMenu,
    setMessageActionMenu,
    showImage,
    setShowImage,
    imageURL,
    setImageURL,
    connectivity,
    isInitialized,
    applySubscriptionSnapshot,
  } = useAppStore();
  const { socket } = useSocket();

  const [previewFileName, setPreviewFileName] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // Count of new tail messages that arrived while the user was scrolled
  // up. Rendered as a badge on the scroll-to-bottom button so the user
  // has a clear affordance to jump down and see what's new. Ref + state:
  // ref is the synchronous read source for the messages effect, state
  // is what re-renders the badge.
  const [newTailMessageCount, setNewTailMessageCount] = useState(0);
  const newTailMessageCountRef = useRef(0);
  const containerRef = useRef(null);
  const newMessageRef = useRef(null);
  const isInitialLoad = useRef(true);
  const lastMessageCountRef = useRef(0);
  // The id of the most recent message we've already reacted to. Used to
  // detect "a NEW message landed at the tail" reliably even when the
  // array is reset to a smaller window (e.g. when `subscribeMessages`
  // emits the latest 50 rows after a write that pruned older ones).
  // Counting alone misses these cases — the count can stay flat or
  // shrink while the tail still moved forward.
  const lastTailIdRef = useRef(null);
  const wasNearBottomRef = useRef(true);
  // Tracks whether the initial scroll-to-bottom has fired for the
  // current chat session. The container's `scrollTop` is stale on
  // chat-open (it carries over from the previous chat, or is 0 on
  // fresh mount), so checking `isNearBottom()` on the very first
  // commit returns false even though the user clearly wants to
  // land at the tail. We force the first scroll unconditionally,
  // then gate the rest of the initial-load window on the live
  // `isNearBottom()` reading. Reset in the chat-open useEffect.
  const initialScrollDoneRef = useRef(false);
  // Synchronous guard against firing multiple paginations from a
  // single user action. `getMessages`/`getChannelMessages` use the
  // React `loading` state to prevent re-entry, but `setLoading(true)`
  // is async (React batches) and the scroll handler's `useCallback`
  // only re-attaches a new closure after the next commit. In the
  // race window, two scroll events that land before the commit both
  // see `loading === false` in their closure and each initiate a
  // pagination. The result: 2-3 in-flight `getMessages` calls, each
  // capturing the same `scrollYBeforeFetch`, and each one fires a
  // rAF that pushes the user further from the top (`scrollTop =
  // newScrollHeight - scrollYBeforeFetch` shrinks as more pages land
  // on top of each other). The user perceives this as "scroll bar
  // keeps shrinking, I'm being shoved down". A ref updates
  // synchronously, so checking this in the scroll handler (and inside
  // the page-fetchers) closes the window. Reset in the `finally`
  // block so a failed/aborted fetch still allows the next attempt.
  const paginationInFlightRef = useRef(false);
  const longPressTimerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState(null); // { top, left, direction }
  const prevTypingUsersLengthRef = useRef(0);
  const selectedChatId = selectedChatData?._id;
  const highlightTimeoutRef = useRef(null);
  const lastHighlightedRef = useRef(null);
  const pendingHighlightRef = useRef(null);
  const observerRef = useRef(null);
  const touchStateRef = useRef({
    id: null,
    startX: 0,
    startY: 0,
    lastDx: 0,
    active: false,
  });
  const [swipeState, setSwipeState] = useState({ id: null, offset: 0 });
  // Tracks the highest server-side page number we've already fetched from
  // the backend for the current conversation. Local-only pagination doesn't
  // touch this — it only advances when we actually issue an axios call.
  // Keeping a ref (not state) so successive `getMessages(page+1)` reads
  // see the latest value without a re-render race.
  const lastServerPageRef = useRef(0);
  const paginationAnchorRef = useRef(null);

  // Typing indicator state
  const typingUsers = selectedChatId
    ? typingIndicators[selectedChatId] || []
    : [];

  // Check if user is near bottom of scroll
  const isNearBottom = useCallback(() => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight < 150;
  }, []);

  // Smooth scroll to bottom function. Schedules two rAF passes — the
  // first lets React commit, the second runs after layout has flushed
  // so `scrollHeight` reflects the freshly added message bubble. Without
  // the double-rAF, scrolling a tall message into view sometimes lands
  // a few pixels short of the bottom on Android WebView.
  const scrollToBottom = useCallback((smooth = true) => {
    const container = containerRef.current;
    if (!container) return;
    const doScroll = () => {
      if (!containerRef.current) return;
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: smooth ? "smooth" : "auto",
      });
    };
    requestAnimationFrame(() => {
      doScroll();
      requestAnimationFrame(doScroll);
    });
  }, []);

  // Capture the message at the top of the scroll viewport. Used as the
  // anchor for preserving the user's scroll position across a pagination
  // — anchoring to a specific message identity is robust to anything
  // that changes the content height between capture and apply (the
  // top-of-list loading spinner, an `applySubscriptionSnapshot` that
  // prepends an offline-backlog row mid-fetch, image lazy-load, etc.).
  // Returns the message's `_id` and its viewport position relative to
  // the container's content top, or `null` if no message is in view.
  const captureScrollAnchor = useCallback((container) => {
    if (!container) return null;
    const containerTop = container.getBoundingClientRect().top;
    const messageEls = container.querySelectorAll("[data-message-id]");
    for (const el of messageEls) {
      // Anchor to the actual message bubble, not the wrapper. 
      // The wrapper includes the date separator, which can appear or disappear 
      // during pagination (e.g., if older messages from the same day are loaded),
      // causing the wrapper's height to change and creating a visual jump.
      const inner = el.querySelector('.animate-message-in') || el;
      const rect = inner.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        return {
          id: el.dataset.messageId,
          viewportTop: rect.top - containerTop,
        };
      }
    }
    return null;
  }, []);

  // Apply a captured anchor to the live DOM. Re-measures the same
  // message's viewport position after the new rows have rendered, then
  // adjusts `scrollTop` by however far the element shifted in the
  // content. Anchoring to the message identity (not a height delta)
  // means the shift is exact even if other height changes happened
  // between the two reads.
  const applyScrollAnchor = useCallback((container, anchor) => {
    if (!container || !anchor) return;
    const el = document.getElementById(`msg-${anchor.id}`);
    if (!el) return;
    const inner = el.querySelector('.animate-message-in') || el;
    const containerTop = container.getBoundingClientRect().top;
    const newViewportTop = inner.getBoundingClientRect().top - containerTop;
    const adjustment = computeAnchorAdjustment(anchor.viewportTop, newViewportTop);
    if (adjustment !== 0) {
      container.scrollTop += adjustment;
    }
  }, []);

  const getMessages = async (pageNumber = 1) => {
    if (!selectedChatId || !hasMore) return;
    // Page 1 is the chat-open path — always allow it (the chat-open
    // IIFE awaits a single resolution). For page > 1, the synchronous
    // ref guard prevents a second `getMessages` from starting while
    // the first one is still in flight. The `loading` state check
    // below is a secondary guard for slower paths, but it's not
    // sufficient on its own because `setLoading(true)` is async and
    // multiple scroll events can fire before React commits it.
    if (pageNumber > 1) {
      if (loading || paginationInFlightRef.current) return;
      paginationInFlightRef.current = true;
    } else if (loading) {
      return;
    }

    setLoading(true);
    try {
      // Native path: try the local repository on every page (Req 1.2, 5.5).
      // Page 1 grabs the most recent `limit` messages; subsequent pages
      // use a `before` cursor (the oldest message currently in the store)
      // to walk older history. Only when the repo has no more rows do we
      // fall through to axios so older history can still be paged in
      // when the local cache hasn't been warmed.
      let localExhausted = false;
      if (Capacitor.isNativePlatform()) {
        const repo = getRepository();
        if (repo.isReady()) {
          /** @type {{ conversationId: string, conversationType: "dm", limit: number, before?: string }} */
          const args = {
            conversationId: selectedChatId,
            conversationType: "dm",
            // Match `repositories/index.js:3007` `emitMessages` default
            // (50) so the chat-open read returns the same window the
            // live-update subscription returns. A mismatch here causes
            // a visible flash on chat-open — the view shrinks from the
            // larger window to the smaller one (or grows, on the
            // pre-IIFE code path).
            limit: 50,
          };
          if (pageNumber > 1) {
            // The store already holds the messages we've shown so far —
            // pick the oldest `createdAt` as the `before` cursor.
            const oldest = selectedChatMessages.reduce((acc, m) => {
              if (!m || typeof m.createdAt !== "string") return acc;
              if (acc == null) return m.createdAt;
              return m.createdAt < acc ? m.createdAt : acc;
            }, null);
            if (oldest != null) args.before = oldest;
          }
          const localMessages = await repo.getMessages(args);
          if (localMessages.length > 0) {
            // Repository returns rows in descending `created_at` order
            // (newest first). The chat UI renders top-to-bottom and
            // expects ascending order (newest at the bottom). Reverse
            // before mapping to mirror the network path which already
            // reverses the backend's descending response.
            const uiMessages = localMessages
              .slice()
              .reverse()
              .map(toUiMessage);
            // Detect "all rows we got back are already in the store" —
            // this happens when the local cache boundary is straddled
            // by messages with identical `created_at`s, since the
            // `before` cursor is a strict `<` and skips ties. In that
            // case treat the local cache as exhausted and let the
            // network path fill in older history.
            const known = new Set(
              selectedChatMessages
                .map((m) => (m && typeof m._id === "string" ? m._id : null))
                .filter(Boolean),
            );
            const newCount = uiMessages.reduce(
              (acc, m) =>
                m && typeof m._id === "string" && !known.has(m._id)
                  ? acc + 1
                  : acc,
              0,
            );
            if (newCount > 0 || pageNumber === 1) {
              if (pageNumber > 1) {
                paginationAnchorRef.current = captureScrollAnchor(containerRef.current);
              }
              setSelectedChatMessages(uiMessages, false);
              if (pageNumber === 1) {
                isInitialLoad.current = true;
              }
              setPage(pageNumber);
              setLoading(false);
              return;
            }
            // No new rows — the store already has every id the local
            // repo handed us. Mark exhausted and continue to the
            // network path below.
            console.log(
              `[MessageContainer] DM local page ${pageNumber} returned ${localMessages.length} rows but all duplicates (cache boundary tie); falling through to network`,
            );
            localExhausted = true;
          } else {
            // Repository ran out of local rows for this page — mark it
            // exhausted so the network fetch below uses a server-side
            // page number derived from the store size, not our local
            // page counter (the two only match if the local cache is
            // an exact multiple of 20).
            localExhausted = true;
          }
        }
      }

      // Web path or repo exhausted: fetch from network. We track the
      // highest server-side page we've already fetched in
      // `lastServerPageRef` and increment it for each new network call.
      // A naïve `Math.floor(store.length / 20) + 1` would loop on the
      // same page whenever a server response overlaps with the local
      // cache (the dedup absorbs the overlap, store size grows by less
      // than 20, the formula recomputes to the same page).
      let serverPage;
      let newCount = 0;
      let responseData = [];
      const sizeBefore = selectedChatMessages.length;
      const networkPageLimit = Capacitor.isNativePlatform()
        ? NATIVE_NETWORK_PAGE_LIMIT
        : WEB_NETWORK_PAGE_LIMIT;

      while (newCount === 0) {
        if (lastServerPageRef.current === 0) {
          // First network call for this conversation. Seed from the
          // current store size so we resume just before the oldest local
          // message we already have.
          serverPage = Math.max(
            1,
            Math.floor(sizeBefore / networkPageLimit) + 1,
          );
        } else {
          serverPage = lastServerPageRef.current + 1;
        }

        // Skip the network fetch entirely when offline.
        if (Capacitor.isNativePlatform() && connectivity === "offline") {
          setHasMore(false);
          setLoading(false);
          return;
        }

        const response = await axios.get(
          `${HOST}${PRIVATE_CONTACT_MESSAGES_ROUTE}/${selectedChatId}?page=${serverPage}&limit=${networkPageLimit}`,
          {
            withCredentials: true,
            timeout: 15_000,
          }
        );

        lastServerPageRef.current = serverPage;

        console.log(
          `[MessageContainer] DM network page ${serverPage} returned ${response.data?.length ?? 0} rows for ${selectedChatId} (localExhausted=${localExhausted}, store size=${sizeBefore})`,
        );

        if (response.data.length === 0) {
          setHasMore(false);
          setLoading(false);
          return;
        }

        const known = new Set(
          selectedChatMessages
            .map((m) => (m && typeof m._id === "string" ? m._id : null))
            .filter(Boolean),
        );
        newCount = response.data.reduce(
          (acc, m) =>
            m && typeof m._id === "string" && !known.has(m._id) ? acc + 1 : acc,
          0,
        );

        if (newCount === 0) {
          console.log(
            `[MessageContainer] DM page ${serverPage} fully overlapped; advancing to page ${serverPage + 1}`,
          );
          // Loop continues to fetch the next page synchronously
        } else {
          responseData = response.data;
        }
      }

      if (pageNumber > 1) {
        paginationAnchorRef.current = captureScrollAnchor(containerRef.current);
      }
      setSelectedChatMessages(responseData, false);

      if (pageNumber === 1) {
        isInitialLoad.current = true;
      }

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
      if (pageNumber > 1) paginationInFlightRef.current = false;
    }
  };

  const getChannelMessages = async (pageNumber = 1) => {
    if (!selectedChatId || !hasMore) return;
    if (pageNumber > 1) {
      if (loading || paginationInFlightRef.current) return;
      paginationInFlightRef.current = true;
    } else if (loading) {
      return;
    }
    setLoading(true);

    try {
      // Native path: try the local repository on every page (Req 1.2, 5.5).
      // See `getMessages` above for the pagination cursor rationale.
      let localExhausted = false;
      if (Capacitor.isNativePlatform()) {
        const repo = getRepository();
        if (repo.isReady()) {
          /** @type {{ conversationId: string, conversationType: "channel", limit: number, before?: string }} */
          const args = {
            conversationId: selectedChatId,
            conversationType: "channel",
            // Match `repositories/index.js:3007` `emitMessages` default
            // (50) so the chat-open read returns the same window the
            // live-update subscription returns. A mismatch here causes
            // a visible flash on channel-open — the view shrinks from
            // the larger window to the smaller one.
            limit: 50,
          };
          if (pageNumber > 1) {
            const oldest = selectedChatMessages.reduce((acc, m) => {
              if (!m || typeof m.createdAt !== "string") return acc;
              if (acc == null) return m.createdAt;
              return m.createdAt < acc ? m.createdAt : acc;
            }, null);
            if (oldest != null) args.before = oldest;
          }
          const localMessages = await repo.getMessages(args);
          if (localMessages.length > 0) {
            const uiMessages = localMessages
              .slice()
              .reverse()
              .map(toUiMessage);
            // See `getMessages` above for the duplicate-detection
            // rationale.
            const known = new Set(
              selectedChatMessages
                .map((m) => (m && typeof m._id === "string" ? m._id : null))
                .filter(Boolean),
            );
            const newCount = uiMessages.reduce(
              (acc, m) =>
                m && typeof m._id === "string" && !known.has(m._id)
                  ? acc + 1
                  : acc,
              0,
            );
            if (newCount > 0 || pageNumber === 1) {
              setSelectedChatMessages(uiMessages, false);
              if (pageNumber === 1) {
                isInitialLoad.current = true;
              }
              setPage(pageNumber);
              setLoading(false);
              return;
            }
            console.log(
              `[MessageContainer] Channel local page ${pageNumber} returned ${localMessages.length} rows but all duplicates (cache boundary tie); falling through to network`,
            );
            localExhausted = true;
          } else {
            localExhausted = true;
          }
        }
      }

      let serverPage;
      let newCount = 0;
      let responseData = [];
      const sizeBefore = selectedChatMessages.length;
      const networkPageLimit = Capacitor.isNativePlatform()
        ? NATIVE_NETWORK_PAGE_LIMIT
        : WEB_NETWORK_PAGE_LIMIT;

      while (newCount === 0) {
        if (lastServerPageRef.current === 0) {
          serverPage = Math.max(
            1,
            Math.floor(sizeBefore / networkPageLimit) + 1,
          );
        } else {
          serverPage = lastServerPageRef.current + 1;
        }

        if (Capacitor.isNativePlatform() && connectivity === "offline") {
          setHasMore(false);
          setLoading(false);
          return;
        }

        const response = await axios.get(
          `${HOST}${CHANNEL_MESSAGES_ROUTE}/${selectedChatId}?page=${serverPage}&limit=${networkPageLimit}`,
          {
            withCredentials: true,
            timeout: 15_000,
          }
        );

        lastServerPageRef.current = serverPage;

        console.log(
          `[MessageContainer] Channel network page ${serverPage} returned ${response.data?.length ?? 0} rows for ${selectedChatId} (localExhausted=${localExhausted}, store size=${sizeBefore})`,
        );

        if (response.data.length === 0) {
          setHasMore(false);
          setLoading(false);
          return;
        }

        const known = new Set(
          selectedChatMessages
            .map((m) => (m && typeof m._id === "string" ? m._id : null))
            .filter(Boolean),
        );
        newCount = response.data.reduce(
          (acc, m) =>
            m && typeof m._id === "string" && !known.has(m._id) ? acc + 1 : acc,
          0,
        );

        if (newCount === 0) {
          console.log(
            `[MessageContainer] Channel page ${serverPage} fully overlapped; advancing to page ${serverPage + 1}`,
          );
          // Loop continues to fetch the next page synchronously
        } else {
          responseData = response.data;
        }
      }

      if (pageNumber > 1) {
        paginationAnchorRef.current = captureScrollAnchor(containerRef.current);
      }
      setSelectedChatMessages(responseData, false);

      if (pageNumber === 1) {
        isInitialLoad.current = true;
      }

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
      if (pageNumber > 1) paginationInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (selectedChatId) {
      // Reset the network pagination cursor — each conversation has its
      // own server-side page sequence.
      lastServerPageRef.current = 0;
      // Reset the tail-id tracker so the next first message in this
      // conversation is treated as "new" and triggers the initial-load
      // scroll-to-bottom branch.
      lastTailIdRef.current = null;
      // Treat every chat-open as a fresh initial-load until the user
      // actively scrolls up. Without this, the auto-scroll effect can
      // race the repository's `subscribeMessages` listener: the first
      // emit lands after `isInitialLoad` was flipped to false (by the
      // old 100ms timeout) and the new tail id matches whatever
      // getMessages(1) just wrote, so `tailChanged === false` and no
      // scroll happens — the user sees messages but not pinned to the
      // bottom. `wasNearBottomRef` is reset too because it carries
      // over from the previous chat (if the user scrolled up there,
      // it was false, which would suppress scroll-on-arrival here).
      isInitialLoad.current = true;
      wasNearBottomRef.current = true;
      // A fresh chat has no "new messages" badge to surface — the user
      // is opening the chat for the first time and the next commit is
      // the initial-load that scrolls to the bottom anyway.
      newTailMessageCountRef.current = 0;
      setNewTailMessageCount(0);
      // The first commit after chat-open scrolls to the bottom
      // unconditionally (the container's `scrollTop` is stale from
      // the previous chat and `isNearBottom()` would return false
      // — see the comment on `initialScrollDoneRef`).
      initialScrollDoneRef.current = false;
      if (selectedChatType === "contact") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        // Show the local window immediately, then top it up in the
        // background. Blocking on refresh here makes the chat appear to
        // "wake up" 1-2 seconds after tap on native even when SQLite
        // already has most of the conversation cached.
        getMessages(1);
        if (Capacitor.isNativePlatform()) {
          const engine = tryGetSyncEngine();
          if (engine && typeof engine.refreshConversation === "function") {
            engine
              .refreshConversation({
                conversationId: selectedChatId,
                conversationType: "dm",
              })
              .catch(() => {
                // Silently ignore.
              });
          }
        }
        // Mark-read is sent through THREE channels for durability:
        //   1. Socket emit — instant, but lost if the socket is mid-
        //      reconnect when we fire.
        //   2. REST POST — durable, succeeds even if socket is dead.
        //   3. OutboundQueue (native only) — survives offline + app
        //      close, retries automatically when connectivity returns.
        // Without all three, the unread count gets stuck at the
        // previous value because the server never learned the user
        // opened the chat.
        if (socket && user?.id) {
          socket.emit("confirm-read", {
            userId: user.id,
            senderId: selectedChatId,
          });
        }
        // Fire the REST call regardless of platform. Errors are
        // swallowed: the queue (on native) or a future chat-open will
        // retry. Using a relative path so axios picks up the configured
        // baseURL / withCredentials cookie.
        axios
          .post(
            `${HOST}${MARK_READ_ROUTE}/${selectedChatId}`,
            {},
            { withCredentials: true, timeout: 10_000 },
          )
          .catch(() => {
            // Network/HTTP failure — fall through to the queue (native)
            // or accept that the next /dm-contacts will resync.
          });
        if (Capacitor.isNativePlatform()) {
          const repo = getRepository();
          if (repo.isReady()) {
            if (typeof repo.resetUnreadCount === "function") {
              repo.resetUnreadCount(selectedChatId).catch(() => {});
            }
            if (typeof repo.applyStatusUpdate === "function") {
              repo.applyStatusUpdate({
                conversationId: selectedChatId,
                fromUserId: selectedChatId,
                status: "read",
              }).catch(() => {});
            }
            // Durable queue entry — drains via socket once connected.
            // Idempotent: server-side mark-read is a no-op if already
            // read, so a double-fire (socket + queue) is harmless.
            try {
              const queue = getOutboundQueue();
              if (queue && typeof queue.enqueue === "function" && user?.id) {
                queue
                  .enqueue({
                    kind: "mark_read",
                    conversationId: selectedChatId,
                    conversationType: "dm",
                    payload: {
                      senderId: selectedChatId,
                      userId: user.id,
                    },
                  })
                  .catch(() => {});
              }
            } catch {
              // OutboundQueue not initialised yet — fine, the live
              // socket emit + REST call above already covered it.
            }
          }
        }
        resetUnreadCount(selectedChatId);
      }
      if (selectedChatType === "channel") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getChannelMessages(1);
        if (Capacitor.isNativePlatform()) {
          const engine = tryGetSyncEngine();
          if (engine && typeof engine.refreshConversation === "function") {
            engine
              .refreshConversation({
                conversationId: selectedChatId,
                conversationType: "channel",
              })
              .catch(() => {
                // Silently ignore.
              });
          }
        }
      }
    }
  }, [
    selectedChatId,
    selectedChatType,
    setSelectedChatMessages,
    socket,
    user?.id,
    resetUnreadCount,
    isInitialized,
  ]);

  // Subscribe to live repository updates for the current conversation (Req 1.2, 5.5).
  // Fires whenever the SyncEngine or OutboundQueue commits a write to the
  // messages table, keeping the UI in sync without a separate poll.
  //
  // The repository's `emitMessages` carries a "newest 50" snapshot. The
  // chat window can also hold messages NOT in that snapshot — older
  // rows the user paged in via scroll-up, plus optimistic placeholders
  // waiting for server confirmation. We do a smart merge
  // (applySubscriptionSnapshot) instead of a destructive reset, so a
  // live socket delivery / read receipt / periodic sync firing while
  // the user is scrolled up does not kick them back to the newest 50.
  useEffect(() => {
    if (!selectedChatId || !Capacitor.isNativePlatform()) return;
    const repo = getRepository();
    if (!repo.isReady()) return;

    const unsubscribe = repo.subscribeMessages(selectedChatId, (messages) => {
      const uiMessages = Array.isArray(messages)
        ? messages.slice().reverse().map(toUiMessage)
        : [];
      applySubscriptionSnapshot(uiMessages);
    });

    return () => {
      unsubscribe();
    };
  }, [selectedChatId, applySubscriptionSnapshot, isInitialized]);

  // Clear typing indicators when leaving chat
  useEffect(() => {
    return () => {
      if (selectedChatData?._id) {
        clearTypingIndicatorsForChat(selectedChatData._id);
      }
    };
  }, [selectedChatData?._id, clearTypingIndicatorsForChat]);

  const messagesRef = useRef(new Map());

  const applyReplyHighlight = (target) => {
    if (!target) return;
    if (lastHighlightedRef.current && lastHighlightedRef.current !== target) {
      lastHighlightedRef.current.classList.remove("reply-highlight");
    }
    target.classList.remove("reply-highlight");
    void target.offsetWidth;
    target.classList.add("reply-highlight");
    lastHighlightedRef.current = target;
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = setTimeout(() => {
      target.classList.remove("reply-highlight");
    }, 2600);
  };

  const observeHighlightWhenVisible = (messageId) => {
    if (!messageId || !containerRef.current) return;
    const target = document.getElementById(`msg-${messageId}`);
    if (!target) return;

    pendingHighlightRef.current = messageId;

    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const entryId = entry.target.dataset.messageId;
            if (!entryId || entryId !== pendingHighlightRef.current) return;
            applyReplyHighlight(entry.target);
            observerRef.current?.unobserve(entry.target);
            pendingHighlightRef.current = null;
          });
        },
        {
          root: containerRef.current,
          threshold: 0.6,
        },
      );
    }

    const rootBounds = containerRef.current.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const alreadyVisible =
      targetBounds.top >= rootBounds.top &&
      targetBounds.bottom <= rootBounds.bottom;

    if (alreadyVisible) {
      applyReplyHighlight(target);
      pendingHighlightRef.current = null;
      return;
    }

    observerRef.current.observe(target);
  };

  const scrollToMessage = (messageId) => {
    if (!messageId) return;
    const target = document.getElementById(`msg-${messageId}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      observeHighlightWhenVisible(messageId);
    }
  };

  const getReplyPreviewText = (replyTo) => {
    if (!replyTo) return "";
    if (replyTo.messageType === "file") {
      return replyTo.fileName || replyTo.previewText || "File";
    }
    return replyTo.previewText || "Message";
  };

  const getReplySenderLabel = (replyTo) => {
    if (!replyTo?.senderId) return "Unknown";
    if (String(replyTo.senderId) === String(user?.id)) return "You";
    const contactName =
      `${selectedChatData?.firstName || ""} ${selectedChatData?.lastName || ""}`.trim();
    return contactName || selectedChatData?.email || "Contact";
  };

  // Format typing indicator label
  const formatTypingLabel = () => {
    if (typingUsers.length === 0) return "";

    if (selectedChatType === "contact") {
      const userName =
        `${typingUsers[0]?.firstName || ""} ${typingUsers[0]?.lastName || ""}`.trim() ||
        "Someone";
      return `${userName} is typing...`;
    }

    const names = typingUsers
      .map((typingUser) =>
        `${typingUser.firstName || ""} ${typingUser.lastName || ""}`.trim(),
      )
      .filter(Boolean);

    if (names.length === 0) return "Someone is typing...";
    if (names.length === 1) return `${names[0]} is typing...`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
    return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing...`;
  };

  const checkIfImage = (filePath) => {
    const imageRegex =
      /\.(jpg|jpeg|png|gif|bmp|tiff|tif|webp|svg|ico|heic|heif)$/i;
    return imageRegex.test(filePath);
  };

  const downloadFile = async (url, fileName) => {
    try {
      setIsDownloading(true);
      setFileDownloadingProgress(0);
      
      const downloadUrl = `${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}`;
      
      const response = await axios.get(downloadUrl, {
        responseType: "blob",
        onDownloadProgress: (data) =>
          setFileDownloadingProgress(
            Math.round((100 * data.loaded) / (data.total || 1))
          ),
      });

      setIsDownloading(false);

      if (Capacitor.isNativePlatform()) {
        const reader = new FileReader();
        reader.readAsDataURL(response.data);
        reader.onloadend = async () => {
          const base64data = reader.result.split(',')[1];
          const nativePlugin = window?.Capacitor?.Plugins?.NativeWebRTC;
          if (nativePlugin?.saveFile) {
            try {
              await nativePlugin.saveFile({ 
                data: base64data, 
                fileName: fileName || url.split("/").pop() || "file",
                mimeType: response.data.type
              });
              toast.success("File saved to Downloads");
            } catch (err) {
              console.error("Failed to save file via native plugin:", err);
              toast.error("Failed to save file");
            }
          } else {
            console.error("NativeWebRTCPlugin or saveFile method not found");
            toast.error("Native download not supported");
          }
        };
      } else {
        const urlBlob = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement("a");
        link.href = urlBlob;
        link.setAttribute("download", fileName || url.split("/").pop() || "file");

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(urlBlob);
      }
    } catch (error) {
      console.log("Error downloading file: ", error);
      setIsDownloading(false);
    }
  };

  // Message status indicator component - bright sky-blue for read visibility
  const MessageStatus = ({ status }) => (
    <span className="inline-flex items-center ml-1.5">
      {(status === "sending" || status === "pending") && (
        <svg className="w-3.5 h-3.5 text-white/50 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      )}
      {status === "failed" && (
        <span className="text-red-400 text-[10px] font-bold">!</span>
      )}
      {status === "sent" && (
        <MdDone className="w-4 h-4 text-white/70" />
      )}
      {status === "delivered" && (
        <IoMdDoneAll className="w-4 h-4 text-white/70" />
      )}
      {status === "read" && (
        <IoMdDoneAll className="w-4 h-4 text-sky-300" />
      )}
    </span>
  );

  const handleDeleteForMe = async (messageId) => {
    try {
      if (Capacitor.isNativePlatform()) {
        const repo = getRepository();
        if (repo.isReady()) {
          await repo.enqueueOutbound({
            kind: "delete_for_me",
            conversationId: selectedChatData._id,
            conversationType: selectedChatType === "contact" ? "dm" : selectedChatType,
            payload: { messageId }
          });
        }
      } else {
        await axios.patch(
          `${HOST}${DELETE_FOR_ME_ROUTE}/${messageId}/delete-for-me`,
          {},
          { withCredentials: true }
        );
      }
      deleteMessageForMe(messageId);
    } catch (error) {
      console.error("Delete for me failed:", error);
    } finally {
      closeActionMenu();
    }
  };

  const handleDeleteForEveryone = async (messageId) => {
    try {
      if (Capacitor.isNativePlatform()) {
        const repo = getRepository();
        if (repo.isReady()) {
          await repo.enqueueOutbound({
            kind: "delete_for_everyone",
            conversationId: selectedChatData._id,
            conversationType: selectedChatType === "contact" ? "dm" : selectedChatType,
            payload: { messageId }
          });
        }
      } else {
        await axios.patch(
          `${HOST}${DELETE_FOR_EVERYONE_ROUTE}/${messageId}/delete-for-everyone`,
          {},
          { withCredentials: true }
        );
      }
      replaceWithDeletedPlaceholder(messageId);
    } catch (error) {
      console.error("Delete for everyone failed:", error);
    } finally {
      closeActionMenu();
    }
  };

  const handleReplyFromMenu = () => {
    if (messageActionMenu?.message) {
      setReplyToMessage(messageActionMenu.message);
    }
    closeActionMenu();
  };

  const getCopyableMessageText = useCallback((message) => {
    if (!message || message.messageType !== "text") return "";
    return typeof message.content === "string" ? message.content : "";
  }, []);

  const copyTextToClipboard = useCallback(async (text) => {
    if (!text) return false;

    try {
      const nativeClipboard = window?.Capacitor?.Plugins?.Clipboard;
      if (Capacitor.isNativePlatform() && nativeClipboard?.write) {
        await nativeClipboard.write({ string: text });
        return true;
      }

      if (navigator?.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }

      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return copied;
    } catch (error) {
      console.error("Failed to copy message:", error);
      return false;
    }
  }, []);

  const handleCopyFromMenu = useCallback(async () => {
    const copyText = getCopyableMessageText(messageActionMenu?.message);
    if (!copyText.trim()) {
      closeActionMenu();
      return;
    }

    const copied = await copyTextToClipboard(copyText);
    if (copied) {
      toast.success("Message copied");
    } else {
      toast.error("Unable to copy message");
    }
    closeActionMenu();
  }, [copyTextToClipboard, getCopyableMessageText, messageActionMenu?.message]);

  const openActionMenu = (message, isSent, anchorEl) => {
    const isDesktop = window.innerWidth >= 640; // sm breakpoint
    if (isDesktop && anchorEl) {
      const rect = anchorEl.closest('.message-bubble')?.getBoundingClientRect() || anchorEl.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      const spaceBelow = viewportHeight - rect.bottom;
      const direction = spaceBelow >= 160 ? 'below' : 'above';

      // Align menu to the right (under the right arrow) for all messages
      let left = rect.right - 180;

      // Keep menu within viewport boundaries with a 10px margin
      if (left < 10) {
        left = 10;
      } else if (left + 180 > viewportWidth - 10) {
        left = viewportWidth - 180 - 10;
      }

      setMenuPosition({
        top: direction === 'below' ? rect.bottom + 4 : rect.top - 4,
        left,
        direction,
      });
    } else {
      setMenuPosition(null);
    }
    setMessageActionMenu({ message, isSent });
  };

  const closeActionMenu = () => {
    setMessageActionMenu(null);
    setMenuPosition(null);
  };

  const startLongPress = (message, isSent) => {
    longPressTimerRef.current = setTimeout(() => {
      openActionMenu(message, isSent, null);
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const renderDeletedPlaceholder = (message, isSent) => (
    <div
      className={cn(
        "flex w-full animate-message-in",
        isSent ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "message-bubble",
          isSent ? "message-bubble-sent opacity-60" : "message-bubble-received opacity-60"
        )}
      >
        <div className="flex items-center gap-2">
          <Ban className="w-4 h-4 shrink-0" />
          <p className="text-sm italic">This message was deleted</p>
        </div>
        <div className="flex items-center justify-end gap-1 mt-1 -mb-1">
          <span
            className={cn(
              "text-[10px]",
              isSent ? "text-primary-foreground/70" : "text-foreground-muted"
            )}
          >
            {moment(message.createdAt).format("LT")}
          </span>
        </div>
      </div>
    </div>
  );

  const openExternalLink = useCallback(async (href) => {
    if (!href) return;

    // Prefer Capacitor Browser plugin when available on native platforms.
    if (Capacitor.isNativePlatform()) {
      const browserPlugin = window?.Capacitor?.Plugins?.Browser;
      if (browserPlugin?.open) {
        try {
          await browserPlugin.open({ url: href });
          return;
        } catch (error) {
          console.warn("Browser plugin open failed, using fallback:", error);
        }
      }

      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
  }, []);

  const handleLinkClick = useCallback(
    async (event, href) => {
      if (!Capacitor.isNativePlatform()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      await openExternalLink(href);
    },
    [openExternalLink]
  );

  const renderTextWithLinks = (text, isSent) => {
    if (!text) return null;

    const nodes = [];
    let lastIndex = 0;
    URL_REGEX.lastIndex = 0;
    let match;
    let key = 0;

    while ((match = URL_REGEX.exec(text)) !== null) {
      const matchedText = match[0];
      const start = match.index;
      const end = start + matchedText.length;
      const { url, trailing } = trimTrailingPunctuation(matchedText);
      const href = toSafeHref(url);

      if (start > lastIndex) {
        nodes.push(text.slice(lastIndex, start));
      }

      if (href) {
        nodes.push(
          <React.Fragment key={`link-${key++}`}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => handleLinkClick(event, href)}
              className={cn(
                "underline underline-offset-2 break-all transition-colors",
                "text-[#53BDEB] hover:text-[#7FD3F3]"
              )}
            >
              {url}
            </a>
            {trailing}
          </React.Fragment>
        );
      } else {
        nodes.push(matchedText);
      }

      lastIndex = end;
    }

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

    return nodes;
  };

  const renderDMMessages = (message, index) => {
    const isSent = message.sender === user.id;

    // Render deleted placeholder
    if (message.deletedForEveryone) {
      return renderDeletedPlaceholder(message, isSent);
    }

    const fileName = message.fileName || message.fileUrl?.split("/").pop() || "";
    const isImage = message.messageType === "file" && checkIfImage(fileName);
    const canReply =
      message.messageType === "text" || message.messageType === "file";
    const emoji = message.messageType === "text" ? analyzeEmoji(message.content) : null;
    const isSwipingThis = swipeState.id === message._id;

    const handleTouchStart = (e) => {
      if (!canReply || e.touches.length !== 1) return;
      const touch = e.touches[0];
      touchStateRef.current = {
        id: message._id,
        startX: touch.clientX,
        startY: touch.clientY,
        lastDx: 0,
        active: true,
      };
    };

    const handleTouchMove = (e) => {
      if (!canReply || !touchStateRef.current.active) return;
      if (touchStateRef.current.id !== message._id) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStateRef.current.startX;
      const dy = touch.clientY - touchStateRef.current.startY;

      if (Math.abs(dy) > 40 && Math.abs(dx) < 20) return;
      if (dx < 0) return;

      const offset = Math.min(dx, 72);
      touchStateRef.current.lastDx = dx;
      setSwipeState({ id: message._id, offset });
    };

    const handleTouchEnd = () => {
      if (!touchStateRef.current.active) return;
      if (touchStateRef.current.id !== message._id) return;
      const shouldTrigger = touchStateRef.current.lastDx > 55;
      touchStateRef.current.active = false;
      touchStateRef.current.lastDx = 0;
      setSwipeState({ id: message._id, offset: 0 });
      if (shouldTrigger && canReply) {
        setReplyToMessage(message);
      }
    };

    return (
      <div
        className={cn(
          "flex w-full animate-message-in",
          isSent ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "message-bubble group",
            isSent ? "message-bubble-sent" : "message-bubble-received",
            emoji?.isEmojiOnly && "!bg-transparent !shadow-none !px-1 !py-0"
          )}
          onTouchStart={(e) => {
            handleTouchStart(e);
            if (!message.isOptimistic) startLongPress(message, isSent);
          }}
          onTouchMove={(e) => {
            handleTouchMove(e);
            cancelLongPress();
          }}
          onTouchEnd={(e) => {
            handleTouchEnd(e);
            cancelLongPress();
          }}
          onTouchCancel={(e) => {
            handleTouchEnd(e);
            cancelLongPress();
          }}
          onContextMenu={(e) => {
            if (message.isOptimistic) return;
            e.preventDefault();
            openActionMenu(message, isSent, e.currentTarget);
          }}
          style={{
            transform: isSwipingThis ? `translateX(${swipeState.offset}px)` : undefined,
            transition:
              isSwipingThis && swipeState.offset > 0
                ? "none"
                : "transform 150ms ease-out",
            touchAction: "pan-y",
          }}
        >
          {/* Hover actions dropdown arrow — hidden while message is still being sent */}
          {!message.isOptimistic && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openActionMenu(message, isSent, e.currentTarget);
            }}
            className={cn(
              "absolute top-0.5 right-0.5 z-10",
              "hidden sm:flex w-6 h-6 items-center justify-center rounded-md",
              "transition-all duration-150",
              "sm:opacity-0 sm:group-hover:opacity-100",
              isSent
                ? "bg-black/15 text-primary-foreground hover:bg-black/25"
                : "bg-black/10 text-foreground hover:bg-black/20"
            )}
          >
            <ChevronDown className="w-4 h-4 drop-shadow-sm" />
          </button>
          )}

          {/* Reply preview */}
          {message.replyTo?.messageId && (
            <button
              onClick={() => scrollToMessage(message.replyTo.messageId)}
              className={cn(
                "mb-1.5 w-full rounded-lg px-2 py-1 text-left text-xs",
                "border-l-2 border-primary/70",
                isSent ? "bg-black/20" : "bg-background-tertiary/60",
              )}
            >
              <span className="block font-semibold text-foreground/90">
                {getReplySenderLabel(message.replyTo)}
              </span>
              <span className="block truncate text-foreground/80">
                {getReplyPreviewText(message.replyTo)}
              </span>
            </button>
          )}
          {/* Text Message */}
          {message.messageType === "text" && (
            <div className="flex flex-col">
              <p className={cn(
                "leading-relaxed break-words whitespace-pre-wrap",
                emoji?.isEmojiOnly ? emoji.sizeClass : "text-sm"
              )}>
                {renderTextWithLinks(message.content, isSent)}
              </p>
              <div className="flex items-center justify-end gap-1 mt-1 -mb-1">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
                {isSent && <MessageStatus status={message.status} isSent={isSent} />}
              </div>
              {/* Still sending indicator — Req 11.4 */}
              {isSent &&
                connectivity === "online" &&
                (message.status === "pending" || message.status === "sending") &&
                Date.now() - new Date(message.createdAt).getTime() > 10_000 && (
                  <span className="mt-0.5 self-end text-[10px] font-medium text-amber-500">
                    Still sending…
                  </span>
              )}
            </div>
          )}

          {/* File Message */}
          {message.messageType === "file" && (
            <div className="flex flex-col">
              {isImage ? (
                <div
                  className="cursor-pointer overflow-hidden rounded-xl max-w-[240px] sm:max-w-[280px] bg-accent/20 relative"
                  style={{
                    width: message.fileMetadata?.width ? `${message.fileMetadata.width}px` : "280px",
                    aspectRatio: message.fileMetadata?.width && message.fileMetadata?.height
                      ? `${message.fileMetadata.width} / ${message.fileMetadata.height}`
                      : undefined,
                  }}
                  onClick={() => {
                    setShowImage(true);
                    setImageURL(message.fileUrl);
                    setPreviewFileName(message.fileName);
                  }}
                >
                  <img
                    src={message.fileUrl}
                    alt="Shared image"
                    className="w-full h-full object-cover transition-transform duration-200 hover:scale-105"
                  />
                </div>
              ) : (
                <div className={cn(
                  "flex items-center gap-3 p-3 rounded-xl",
                  isSent ? "bg-primary-hover" : "bg-background-tertiary"
                )}>
                  <div className={cn(
                    "flex items-center justify-center w-10 h-10 rounded-lg",
                    isSent ? "bg-primary-foreground/20" : "bg-primary/20"
                  )}>
                    <MdFolderZip className={cn(
                      "w-5 h-5",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </div>
                  <span className={cn(
                    "text-sm truncate max-w-[150px] sm:max-w-[200px]",
                    isSent ? "text-primary-foreground" : "text-foreground"
                  )}>
                    {fileName}
                  </span>
                  <button
                    onClick={() => downloadFile(message.fileUrl, message.fileName)}
                    className={cn(
                      "touch-target rounded-full transition-colors",
                      isSent 
                        ? "hover:bg-primary-foreground/20" 
                        : "hover:bg-accent"
                    )}
                  >
                    <IoArrowDownCircle className={cn(
                      "w-6 h-6",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </button>
                </div>
              )}
              <div className="flex items-center justify-end gap-1 mt-1.5">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
                {isSent && <MessageStatus status={message.status} isSent={isSent} />}
              </div>
              {/* Still sending indicator — Req 11.4 */}
              {isSent &&
                connectivity === "online" &&
                (message.status === "pending" || message.status === "sending") &&
                Date.now() - new Date(message.createdAt).getTime() > 10_000 && (
                  <span className="mt-0.5 self-end text-[10px] font-medium text-amber-500">
                    Still sending…
                  </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderChannelMessage = (message, index) => {
    let senderObj = message.sender;
    if (!senderObj || typeof senderObj === "string") {
      const actualSenderId = typeof senderObj === "string" ? senderObj : message.senderId;
      if (actualSenderId && selectedChatData?.members) {
        senderObj = selectedChatData.members.find(
          (m) => m._id === actualSenderId
        );
      }
    }

    const isSent = senderObj?._id === user.id || message.sender === user.id || message.senderId === user.id;

    // Render deleted placeholder
    if (message.deletedForEveryone) {
      return renderDeletedPlaceholder(message, isSent);
    }

    const fileName = message.fileName || message.fileUrl?.split("/").pop() || "";
    const isImage = message.messageType === "file" && checkIfImage(fileName);
    const emoji = message.messageType === "text" ? analyzeEmoji(message.content) : null;

    return (
      <div
        className={cn(
          "flex w-full animate-message-in",
          isSent ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "message-bubble group",
            isSent ? "message-bubble-sent" : "message-bubble-received",
            emoji?.isEmojiOnly && "!bg-transparent !shadow-none !px-1 !py-0"
          )}
          onTouchStart={() => startLongPress(message, isSent)}
          onTouchMove={cancelLongPress}
          onTouchEnd={cancelLongPress}
          onTouchCancel={cancelLongPress}
          onContextMenu={(e) => {
            e.preventDefault();
            openActionMenu(message, isSent, e.currentTarget);
          }}
        >
          {/* Sender name for channel messages (received only) */}
          {!isSent && senderObj && (
            <p className="text-xs font-medium text-primary mb-1">
              {senderObj?.firstName} {senderObj?.lastName}
            </p>
          )}

          {/* Hover actions dropdown arrow (WhatsApp style) */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              openActionMenu(message, isSent, e.currentTarget);
            }}
            className={cn(
              "absolute top-0.5 right-0.5 z-10",
              "hidden sm:flex w-6 h-6 items-center justify-center rounded-md",
              "transition-all duration-150",
              "sm:opacity-0 sm:group-hover:opacity-100",
              isSent
                ? "bg-black/15 text-primary-foreground hover:bg-black/25"
                : "bg-black/10 text-foreground hover:bg-black/20"
            )}
          >
            <ChevronDown className="w-4 h-4 drop-shadow-sm" />
          </button>

          {/* Text Message */}
          {message.messageType === "text" && (
            <div className="flex flex-col">
              <p className={cn(
                "leading-relaxed break-words whitespace-pre-wrap",
                emoji?.isEmojiOnly ? emoji.sizeClass : "text-sm"
              )}>
                {renderTextWithLinks(message.content, isSent)}
              </p>
              <div className="flex items-center justify-end gap-1 mt-1 -mb-1">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
              </div>
            </div>
          )}

          {/* File Message */}
          {message.messageType === "file" && (
            <div className="flex flex-col">
              {isImage ? (
                <div
                  className="cursor-pointer overflow-hidden rounded-xl"
                  onClick={() => {
                    setShowImage(true);
                    setImageURL(message.fileUrl);
                  }}
                >
                  <img
                    src={message.fileUrl}
                    alt="Shared image"
                    className="max-w-[240px] sm:max-w-[280px] h-auto object-cover transition-transform duration-200 hover:scale-105"
                  />
                </div>
              ) : (
                <div className={cn(
                  "flex items-center gap-3 p-3 rounded-xl",
                  isSent ? "bg-primary-hover" : "bg-background-tertiary"
                )}>
                  <div className={cn(
                    "flex items-center justify-center w-10 h-10 rounded-lg",
                    isSent ? "bg-primary-foreground/20" : "bg-primary/20"
                  )}>
                    <MdFolderZip className={cn(
                      "w-5 h-5",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </div>
                  <span className={cn(
                    "text-sm truncate max-w-[150px] sm:max-w-[200px]",
                    isSent ? "text-primary-foreground" : "text-foreground"
                  )}>
                    {fileName}
                  </span>
                  <button
                    onClick={() => downloadFile(message.fileUrl, message.fileName)}
                    className={cn(
                      "touch-target rounded-full transition-colors",
                      isSent 
                        ? "hover:bg-primary-foreground/20" 
                        : "hover:bg-accent"
                    )}
                  >
                    <IoArrowDownCircle className={cn(
                      "w-6 h-6",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </button>
                </div>
              )}
              <div className="flex items-center justify-end gap-1 mt-1.5">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderMessages = () => {
    let lastDate = null;
    return selectedChatMessages.map((message, index) => {
      const messageDate = moment(message.createdAt).format("YYYY-MM-DD");
      const showDate = messageDate !== lastDate;
      lastDate = messageDate;

      if (!messagesRef.current.has(message._id)) {
        messagesRef.current.set(message._id, message);
      }

      return (
        <div
          key={message._stableKey || message._id}
          id={`msg-${message._id}`}
          data-message-id={message._id}
          className="flex flex-col gap-2"
        >
          {showDate && (
            <div className="flex justify-center my-4">
              <span className="date-separator">
                {moment(message.createdAt).format("LL")}
              </span>
            </div>
          )}
          {selectedChatType === "contact" && renderDMMessages(message, index)}
          {selectedChatType === "channel" && renderChannelMessage(message, index)}
        </div>
      );
    });
  };

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const { scrollTop, scrollHeight, clientHeight } = container;
    
    // Show scroll button when scrolled up more than 300px from bottom
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setShowScrollButton(distanceFromBottom > 300);

    // Load more messages when within 300px of the top. The 300px
    // threshold is pre-emptive — the old 50px threshold created a
    // visible "dead zone" where the user had to scroll to within 50px
    // of the top to trigger the next page, which felt like the
    // pagination got stuck. With 300px, the trigger fires continuously
    // as the user scrolls up: each new batch lands before they reach
    // the top, so they can keep scrolling smoothly.
    //
    // `paginationInFlightRef` is the synchronous guard against firing
    // a second pagination while the first is still in flight (see the
    // ref declaration for the full race-condition story).
    if (
      !loading &&
      !paginationInFlightRef.current &&
      hasMore &&
      scrollTop < 300
    ) {
      if (selectedChatType === "contact") {
        getMessages(page + 1);
      } else if (selectedChatType === "channel") {
        getChannelMessages(page + 1);
      }
    }
  }, [loading, hasMore, selectedChatType, page]);

  // Apply scroll anchor synchronously before paint to prevent visible jumps
  useLayoutEffect(() => {
    if (paginationAnchorRef.current && containerRef.current) {
      applyScrollAnchor(containerRef.current, paginationAnchorRef.current);
      paginationAnchorRef.current = null;
    }
  }, [selectedChatMessages, applyScrollAnchor]);

  // Scroll to bottom on initial load and new messages
  useEffect(() => {
    if (!containerRef.current || selectedChatMessages.length === 0) return;

    const currentMessageCount = selectedChatMessages.length;
    const lastMessage = selectedChatMessages[selectedChatMessages.length - 1];
    const lastMessageId = lastMessage?._id ?? null;
    const isOwnMessage =
      lastMessage?.sender === user?.id ||
      lastMessage?.sender?._id === user?.id;
    const isAtBottom = isNearBottom();
    const arrayGrew = currentMessageCount > lastMessageCountRef.current;
    const tailChanged =
      lastMessageId != null && lastMessageId !== lastTailIdRef.current;

    // Delegate the scroll + badge decisions to pure functions. The
    // entire MessageContainer scroll policy is specified in
    // `decideScroll` / `decideBadge` and exhaustively unit-tested
    // in `scrollDecision.test.js` — any change to the policy
    // starts with a test. The component's job is reduced to:
    // gather inputs (refs, live scroll position, message array),
    // call the functions, act on the result.
    const scrollMode = decideScroll({
      isInitialLoad: isInitialLoad.current,
      initialScrollDone: initialScrollDoneRef.current,
      arrayGrew,
      tailChanged,
      isOwnMessage,
      isAtBottom,
    });

    if (scrollMode === "instant-bottom") {
      scrollToBottom(false);
    } else if (scrollMode === "smooth-bottom") {
      scrollToBottom(true);
    }

    const badgeMode = decideBadge({
      isInitialLoad: isInitialLoad.current,
      tailChanged,
      isOwnMessage,
      isAtBottom,
    });

    if (badgeMode === "reset") {
      newTailMessageCountRef.current = 0;
      setNewTailMessageCount(0);
    } else if (badgeMode === "increment") {
      newTailMessageCountRef.current += 1;
      setNewTailMessageCount(newTailMessageCountRef.current);
    }

    // First commit of this chat session has fired; subsequent
    // commits fall through to the `arrayGrew` branch of the policy.
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
    }

    lastMessageCountRef.current = currentMessageCount;
    lastTailIdRef.current = lastMessageId;
    wasNearBottomRef.current = isAtBottom;
  }, [selectedChatMessages, scrollToBottom, user?.id, isNearBottom]);

  // Track scroll position continuously
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const trackPosition = () => {
      const nearBottom = isNearBottom();
      wasNearBottomRef.current = nearBottom;
      // The user actively scrolled away from the bottom — we're past
      // the "initial load" phase, so subsequent message commits should
      // respect the user's scroll position instead of jumping back to
      // the bottom unconditionally.
      if (!nearBottom && isInitialLoad.current) {
        isInitialLoad.current = false;
      }
    };

    container.addEventListener("scroll", trackPosition, { passive: true });
    return () => container.removeEventListener("scroll", trackPosition);
  }, [isNearBottom]);

  // Handle typing indicator appearance - scroll to show it if near bottom
  useEffect(() => {
    const typingUsersLength = typingUsers.length;
    const prevLength = prevTypingUsersLengthRef.current;

    // Typing indicator just appeared
    if (typingUsersLength > 0 && prevLength === 0) {
      if (wasNearBottomRef.current) {
        scrollToBottom(true);
      }
    }

    prevTypingUsersLengthRef.current = typingUsersLength;
  }, [typingUsers.length, scrollToBottom]);

  // Scroll handler for pagination
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll, { passive: true });
    }
    return () => {
      if (container) {
        container.removeEventListener("scroll", handleScroll);
      }
    };
  }, [handleScroll]);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const canCopySelectedMessage = Boolean(
    getCopyableMessageText(messageActionMenu?.message).trim()
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden bg-background px-3 py-4 sm:px-4 md:px-6 relative"
    >
      {/* Pagination indicator — pinned to the top of the scroll viewport
          and overlaid via `absolute` so it never shifts the message list
          (the previous in-flow dots pushed every message down by ~40px
          and created a visible "lift" on every page load). Only shows
          for paginations (page > 1); the initial chat-open is fast
          enough that a spinner is overkill. */}
      {loading && page > 1 && (
        <div className="absolute top-4 left-0 right-0 z-10 flex justify-center pointer-events-none">
          <div className="flex gap-1">
            <div className="typing-dot" />
            <div className="typing-dot" />
            <div className="typing-dot" />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex flex-col gap-1">
        {renderMessages()}
      </div>

      {/* Typing indicator*/}
      {typingUsers.length > 0 && (
        <div className="flex justify-start px-1 py-2 animate-fade-in">
          <div className="message-bubble message-bubble-received flex items-center gap-3 px-4 py-3">
            <div className="flex items-center gap-1">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={newMessageRef} />

      {/* Scroll to bottom button — shows a red badge with the count of
          new tail messages that arrived while the user was scrolled up,
          so they have a clear affordance to jump down to the latest. */}
      <button
        onClick={() => {
          newTailMessageCountRef.current = 0;
          setNewTailMessageCount(0);
          scrollToBottom(true);
        }}
        className={cn(
          "fixed bottom-24 right-4 sm:right-8 z-40 w-10 h-10 rounded-full bg-background-secondary border border-border-subtle shadow-lg flex items-center justify-center transition-all duration-300 hover:bg-accent hover:scale-110 active:scale-95",
          showScrollButton 
            ? "opacity-100 translate-y-0" 
            : "opacity-0 translate-y-4 pointer-events-none"
        )}
        aria-label={
          newTailMessageCount > 0
            ? `Scroll to bottom — ${newTailMessageCount} new message${newTailMessageCount === 1 ? "" : "s"}`
            : "Scroll to bottom"
        }
      >
        <ChevronDown className="w-5 h-5 text-foreground" />
        {newTailMessageCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center shadow-sm pointer-events-none">
            {newTailMessageCount > 99 ? "99+" : newTailMessageCount}
          </span>
        )}
      </button>

      {/* Image Preview Modal */}
      {showImage && imageURL && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm animate-fade-in">
          <div className="relative max-w-[90vw] max-h-[85vh]">
            <img
              src={imageURL}
              alt="Preview"
              className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-chat-lg"
            />
          </div>

          {/* Modal Actions */}
          <div className="fixed top-4 right-4 flex items-center gap-2">
            <button
              onClick={() => downloadFile(imageURL, previewFileName)}
              className="touch-target rounded-full bg-background-secondary hover:bg-accent transition-colors"
            >
              <IoArrowDownCircle className="w-7 h-7 text-foreground" />
            </button>

            <button
              onClick={() => {
                setShowImage(false);
              }}
              className="touch-target rounded-full bg-background-secondary hover:bg-destructive/20 transition-colors"
            >
              <IoCloseSharp className="w-7 h-7 text-foreground" />
            </button>
          </div>
        </div>
      )}

      {/* Message Action Menu */}
      {messageActionMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={closeActionMenu}
        >
          {/* Desktop: positioned contextual dropdown */}
          {menuPosition ? (
            <div
              ref={menuRef}
              className="fixed z-50 w-44 bg-background-secondary border border-border rounded-xl shadow-chat-lg py-1 animate-fade-in"
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                ...(menuPosition.direction === 'above' && { transform: 'translateY(-100%)' }),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={handleReplyFromMenu}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent transition-colors"
              >
                <RiReplyLine className="w-4 h-4 text-foreground-muted" />
                Reply
              </button>
              {canCopySelectedMessage && (
                <button
                  onClick={handleCopyFromMenu}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent transition-colors"
                >
                  <Copy className="w-4 h-4 text-foreground-muted" />
                  Copy
                </button>
              )}
              <button
                onClick={() => handleDeleteForMe(messageActionMenu.message.serverId || messageActionMenu.message._id)}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent transition-colors"
              >
                <Trash2 className="w-4 h-4 text-foreground-muted" />
                Delete for Me
              </button>
              {messageActionMenu.isSent && (
                <button
                  onClick={() => handleDeleteForEveryone(messageActionMenu.message.serverId || messageActionMenu.message._id)}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete for Everyone
                </button>
              )}
            </div>
          ) : (
            /* Mobile: bottom sheet */
            <div
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
              onClick={closeActionMenu}
            >
              <div
                className="w-full max-w-md pb-[env(safe-area-inset-bottom,16px)] bg-background-secondary rounded-t-2xl shadow-chat-lg p-4 animate-sheet-up"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />
                <div className="flex flex-col gap-1">
                  <button
                    onClick={handleReplyFromMenu}
                    className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left text-sm font-medium text-foreground hover:bg-accent transition-colors"
                  >
                    <RiReplyLine className="w-5 h-5 text-foreground-muted" />
                    Reply
                  </button>
                  {canCopySelectedMessage && (
                    <button
                      onClick={handleCopyFromMenu}
                      className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left text-sm font-medium text-foreground hover:bg-accent transition-colors"
                    >
                      <Copy className="w-5 h-5 text-foreground-muted" />
                      Copy
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteForMe(messageActionMenu.message.serverId || messageActionMenu.message._id)}
                    className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left text-sm font-medium text-foreground hover:bg-accent transition-colors"
                  >
                    <Trash2 className="w-5 h-5 text-foreground-muted" />
                    Delete for Me
                  </button>
                  {messageActionMenu.isSent && (
                    <button
                      onClick={() => handleDeleteForEveryone(messageActionMenu.message.serverId || messageActionMenu.message._id)}
                      className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="w-5 h-5" />
                      Delete for Everyone
                    </button>
                  )}
                  <button
                    onClick={closeActionMenu}
                    className="w-full px-4 py-3 rounded-xl text-sm font-medium text-foreground-muted hover:bg-accent transition-colors mt-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MessageContainer;
