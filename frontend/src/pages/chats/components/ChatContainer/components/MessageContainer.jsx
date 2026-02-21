import useAppStore from "@/store";
import {
  CHANNEL_MESSAGES_ROUTE,
  HOST,
  MESSAGES_ROUTE,
  PRIVATE_CONTACT_MESSAGES_ROUTE,
  DELETE_FOR_ME_ROUTE,
  DELETE_FOR_EVERYONE_ROUTE,
} from "@/utils/constants";
import moment from "moment";
import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { MdFolderZip } from "react-icons/md";
import { IoArrowDownCircle, IoCloseSharp } from "react-icons/io5";
import { IoMdDoneAll } from "react-icons/io";
import { MdDone } from "react-icons/md";
import { ChevronDown, Trash2, Ban } from "lucide-react";
import { RiReplyLine } from "react-icons/ri";
import { cn } from "@/lib/utils";
import { useSocket } from "@/context/SocketContext";
import { analyzeEmoji } from "@/utils/emojiUtils";

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
  } = useAppStore();
  const { socket } = useSocket();

  const [showImage, setShowImage] = useState(false);
  const [imageURL, setImageURL] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const containerRef = useRef(null);
  const newMessageRef = useRef(null);
  const isInitialLoad = useRef(true);
  const lastMessageCountRef = useRef(0);
  const wasNearBottomRef = useRef(true);
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

  // Smooth scroll to bottom function
  const scrollToBottom = useCallback((smooth = true) => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }, []);

  const getMessages = async (pageNumber = 1) => {
    if (!selectedChatId || loading || !hasMore) return;

    setLoading(true);
    try {
      const response = await axios.get(
        `${HOST}${PRIVATE_CONTACT_MESSAGES_ROUTE}/${selectedChatId}?page=${pageNumber}&limit=20`,
        {
          withCredentials: true,
        }
      );

      if (response.data.length === 0) setHasMore(false);

      setSelectedChatMessages(response.data, false);

      if (pageNumber === 1) {
        isInitialLoad.current = true;
      }

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  const getChannelMessages = async (pageNumber = 1) => {
    if (!selectedChatId || loading || !hasMore) return;
    setLoading(true);

    try {
      const response = await axios.get(
        `${HOST}${CHANNEL_MESSAGES_ROUTE}/${selectedChatId}?page=${pageNumber}&limit=20`,
        {
          withCredentials: true,
        }
      );
      if (response.data.length === 0) setHasMore(false);

      setSelectedChatMessages(response.data, false);

      if (pageNumber === 1) {
        isInitialLoad.current = true;
      }

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedChatId) {
      if (selectedChatType === "contact") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getMessages(1);
        if (socket && user?.id) {
          socket.emit("confirm-read", {
            userId: user.id,
            senderId: selectedChatId,
          });
        }
        resetUnreadCount(selectedChatId);
      }
      if (selectedChatType === "channel") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getChannelMessages(1);
      }
    }
  }, [
    selectedChatId,
    selectedChatType,
    setSelectedChatMessages,
    socket,
    user?.id,
    resetUnreadCount,
  ]);

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
      return replyTo.fileName || "File";
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

  const downloadFile = async (url) => {
    try {
      setIsDownloading(true);
      setFileDownloadingProgress(0);
      const response = await axios.get(`${url}`, {
        responseType: "blob",
        onDownloadProgress: (data) =>
          setFileDownloadingProgress(
            Math.round((100 * data.loaded) / (data.total || 1))
          ),
      });

      setIsDownloading(false);

      const urlBlob = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = urlBlob;
      link.setAttribute("download", url.split("/").pop() || "file");

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(urlBlob);
    } catch (error) {
      console.log("Error downloading file: ", error);
      setIsDownloading(false);
    }
  };

  // Message status indicator component - bright sky-blue for read visibility
  const MessageStatus = ({ status, isSent }) => (
    <span className="inline-flex items-center ml-1.5">
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
      await axios.patch(
        `${HOST}${DELETE_FOR_ME_ROUTE}/${messageId}/delete-for-me`,
        {},
        { withCredentials: true }
      );
      deleteMessageForMe(messageId);
    } catch (error) {
      console.error("Delete for me failed:", error);
    } finally {
      closeActionMenu();
    }
  };

  const handleDeleteForEveryone = async (messageId) => {
    try {
      await axios.patch(
        `${HOST}${DELETE_FOR_EVERYONE_ROUTE}/${messageId}/delete-for-everyone`,
        {},
        { withCredentials: true }
      );
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

  const openActionMenu = (message, isSent, anchorEl) => {
    const isDesktop = window.innerWidth >= 640; // sm breakpoint
    if (isDesktop && anchorEl) {
      const rect = anchorEl.closest('.message-bubble')?.getBoundingClientRect() || anchorEl.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const direction = spaceBelow >= 160 ? 'below' : 'above';

      setMenuPosition({
        top: direction === 'below' ? rect.bottom + 4 : rect.top - 4,
        left: isSent ? rect.right - 180 : rect.left,
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

  const renderDMMessages = (message, index) => {
    const isSent = message.sender === user.id;

    // Render deleted placeholder
    if (message.deletedForEveryone) {
      return renderDeletedPlaceholder(message, isSent);
    }

    const fileName = message.fileUrl?.split("/").pop() || "";
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
            startLongPress(message, isSent);
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
                {message.content}
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
                    onClick={() => downloadFile(message.fileUrl)}
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
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderChannelMessage = (message, index) => {
    const isSent = message.sender?._id === user.id;

    // Render deleted placeholder
    if (message.deletedForEveryone) {
      return renderDeletedPlaceholder(message, isSent);
    }

    const fileName = message.fileUrl?.split("/").pop() || "";
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
          {!isSent && message.sender && (
            <p className="text-xs font-medium text-primary mb-1">
              {message.sender?.firstName} {message.sender?.lastName}
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
                {message.content}
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
                    onClick={() => downloadFile(message.fileUrl)}
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
          key={message._id}
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

    // Load more messages when near top
    if (!loading && hasMore && scrollTop < 50) {
      const scrollYBeforeFetch = scrollHeight;

      if (selectedChatType === "contact") {
        getMessages(page + 1).then(() => {
          requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight - scrollYBeforeFetch;
            }
          });
        });
      } else if (selectedChatType === "channel") {
        getChannelMessages(page + 1).then(() => {
          requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight - scrollYBeforeFetch;
            }
          });
        });
      }
    }
  }, [loading, hasMore, selectedChatType, page]);

  // Scroll to bottom on initial load and new messages
  useEffect(() => {
    if (!containerRef.current || selectedChatMessages.length === 0) return;

    const currentMessageCount = selectedChatMessages.length;
    const lastMessage = selectedChatMessages[selectedChatMessages.length - 1];
    const isOwnMessage = lastMessage?.sender === user?.id || lastMessage?.sender?._id === user?.id;

    // Initial load - instant scroll to bottom
    if (isInitialLoad.current) {
      requestAnimationFrame(() => {
        scrollToBottom(false);
        setTimeout(() => {
          isInitialLoad.current = false;
          lastMessageCountRef.current = currentMessageCount;
          wasNearBottomRef.current = true;
        }, 100);
      });
      return;
    }

    // New message arrived (not from pagination)
    if (currentMessageCount > lastMessageCountRef.current) {
      const wasAtBottom = wasNearBottomRef.current;
      
      // Always scroll for own messages, or if user was near bottom for received messages
      if (isOwnMessage || wasAtBottom) {
        requestAnimationFrame(() => {
          scrollToBottom(true);
        });
      }
    }

    lastMessageCountRef.current = currentMessageCount;
  }, [selectedChatMessages, scrollToBottom, user?.id]);

  // Track scroll position continuously
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const trackPosition = () => {
      wasNearBottomRef.current = isNearBottom();
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
        requestAnimationFrame(() => {
          scrollToBottom(true);
        });
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

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden bg-background px-3 py-4 sm:px-4 md:px-6"
    >
      {/* Loading indicator */}
      {loading && (
        <div className="flex justify-center py-4">
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

      {/* Scroll to bottom button */}
      <button
        onClick={() => scrollToBottom(true)}
        className={cn(
          "fixed bottom-24 right-4 sm:right-8 z-40 w-10 h-10 rounded-full bg-background-secondary border border-border-subtle shadow-lg flex items-center justify-center transition-all duration-300 hover:bg-accent hover:scale-110 active:scale-95",
          showScrollButton 
            ? "opacity-100 translate-y-0" 
            : "opacity-0 translate-y-4 pointer-events-none"
        )}
        aria-label="Scroll to bottom"
      >
        <ChevronDown className="w-5 h-5 text-foreground" />
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
              onClick={() => downloadFile(imageURL)}
              className="touch-target rounded-full bg-background-secondary hover:bg-accent transition-colors"
            >
              <IoArrowDownCircle className="w-7 h-7 text-foreground" />
            </button>

            <button
              onClick={() => {
                setImageURL(null);
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
              <button
                onClick={() => handleDeleteForMe(messageActionMenu.message._id)}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent transition-colors"
              >
                <Trash2 className="w-4 h-4 text-foreground-muted" />
                Delete for Me
              </button>
              {messageActionMenu.isSent && (
                <button
                  onClick={() => handleDeleteForEveryone(messageActionMenu.message._id)}
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
                  <button
                    onClick={() => handleDeleteForMe(messageActionMenu.message._id)}
                    className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left text-sm font-medium text-foreground hover:bg-accent transition-colors"
                  >
                    <Trash2 className="w-5 h-5 text-foreground-muted" />
                    Delete for Me
                  </button>
                  {messageActionMenu.isSent && (
                    <button
                      onClick={() => handleDeleteForEveryone(messageActionMenu.message._id)}
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
