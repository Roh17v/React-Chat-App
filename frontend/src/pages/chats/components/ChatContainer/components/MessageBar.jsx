import React, { useEffect, useRef, useState, lazy, Suspense } from "react";
import { CgAttachment } from "react-icons/cg";
import { RiEmojiStickerLine } from "react-icons/ri";
import { IoCloseSharp, IoSend } from "react-icons/io5";
const EmojiPicker = lazy(() => import("emoji-picker-react"));
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { UPLOAD_FILE_ROUTE } from "@/utils/constants";
import { cn } from "@/lib/utils";
import { Capacitor } from "@capacitor/core";

const MessageBar = () => {
  const [message, setMessage] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiRef = useRef();
  const inputRef = useRef();
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);
  const {
    selectedChatType,
    selectedChatData,
    user,
    addOptimisticMessage,
    setFileUploadingProgress,
    setIsUploading,
    replyToMessage,
    clearReplyToMessage,
  } = useAppStore();
  const { socket } = useSocket();

  const fileInputRef = useRef();

  const keepInputFocused = () => {
    if (!inputRef.current) return;
    inputRef.current.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  };

  const handleSendMessage = async () => {
    const sanitizedMessage = message.trim();
    if (sanitizedMessage === "") return;

    // Generate a unique temp ID for this optimistic message.
    const tempId = `temp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    if (selectedChatType === "contact") {
      const replyTo = buildReplyPayload(replyToMessage);

      // Instantly add placeholder to the UI with status 'sending'.
      addOptimisticMessage({
        _id: tempId,
        sender: user.id,
        receiver: selectedChatData._id,
        content: sanitizedMessage,
        messageType: "text",
        fileUrl: null,
        replyTo: replyTo || null,
        status: "sending",
        createdAt: now,
        isOptimistic: true,
      });

      // Clear the input immediately
      setMessage("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      clearReplyToMessage();
      keepInputFocused();

      // Send to server in background with the temp ID attached.
      socket.emit("sendMessage", {
        sender: user.id,
        content: sanitizedMessage,
        receiver: selectedChatData._id,
        messageType: "text",
        fileUrl: undefined,
        replyTo: replyTo || undefined,
        clientTempId: tempId,
      });
    } else if (selectedChatType === "channel") {
      socket.emit("send-channel-message", {
        sender: user.id,
        content: sanitizedMessage,
        messageType: "text",
        fileUrl: undefined,
        channelId: selectedChatData._id,
      });
      setMessage("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      clearReplyToMessage();
      keepInputFocused();
    }

    if (isTypingRef.current) {
      socket.emit("stop-typing", {
        chatType: selectedChatType,
        receiverId:
          selectedChatType === "contact" ? selectedChatData._id : null,
        channelId: selectedChatType === "channel" ? selectedChatData._id : null,
      });
      isTypingRef.current = false;
    }
  };

  const handleAddEmoji = (emoji) => {
    setMessage((mssg) => mssg + emoji.emoji);
  };

  const handleAttachmentClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleAttachmentChange = async (e) => {
    const file = e.target.files[0];
    try {
      if (file) {
        const formData = new FormData();
        setIsUploading(true);
        setFileUploadingProgress(0);
        formData.append("file", file);

        const response = await axios.post(UPLOAD_FILE_ROUTE, formData, {
          withCredentials: true,
          onUploadProgress: (data) =>
            setFileUploadingProgress(
              Math.round((100 * data.loaded) / data.total),
            ),
        });

        console.log(response);

        if (response.status === 201 && response.data) {
          setIsUploading(false);
          if (selectedChatType === "contact") {
            const replyTo = buildReplyPayload(replyToMessage);
            socket.emit("sendMessage", {
              sender: user.id,
              content: undefined,
              receiver: selectedChatData._id,
              messageType: "file",
              fileUrl: response.data.fileUrl,
              fileName: file.name,
              replyTo: replyTo || undefined,
            });
          } else if (selectedChatType === "channel") {
            socket.emit("send-channel-message", {
              sender: user.id,
              content: message,
              messageType: "file",
              fileUrl: response.data.fileUrl,
              fileName: file.name,
              channelId: selectedChatData._id,
            });
          }
          clearReplyToMessage();
        }
      }
    } catch (error) {
      console.log("Error sending file: ", error);
      setIsUploading(false);
    }
  };

  const getReplySenderLabel = () => {
    if (!replyToMessage?.sender) return "Unknown";
    if (String(replyToMessage.sender) === String(user?.id)) return "You";
    const contactName =
      `${selectedChatData?.firstName || ""} ${selectedChatData?.lastName || ""}`.trim();
    return contactName || selectedChatData?.email || "Contact";
  };

  const getReplyPreviewText = () => {
    if (!replyToMessage) return "";
    if (replyToMessage.messageType === "file") {
      return (
        replyToMessage.fileName ||
        replyToMessage.fileUrl?.split("/").pop() ||
        "File"
      );
    }
    return replyToMessage.content || "Message";
  };

  const buildReplyPayload = (sourceMessage) => {
    if (!sourceMessage) return null;
    const isFile = sourceMessage.messageType === "file";
    const fileName = isFile
      ? sourceMessage.fileName || sourceMessage.fileUrl?.split("/").pop() || "File"
      : null;
    const previewText = isFile
      ? fileName
      : (sourceMessage.content || "").slice(0, 120);

    return {
      messageId: sourceMessage._id,
      senderId: sourceMessage.sender,
      messageType: sourceMessage.messageType,
      previewText,
      fileName,
      createdAt: sourceMessage.createdAt,
    };
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) {
        setEmojiPickerOpen(false);
      }
    };

    if (emojiPickerOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [emojiPickerOpen]);

  useEffect(() => {
    if (!socket || !selectedChatData?._id) return;

    const shouldEmitTyping = message.trim().length > 0;
    if (shouldEmitTyping && !isTypingRef.current) {
      socket.emit("typing", {
        chatType: selectedChatType,
        receiverId:
          selectedChatType === "contact" ? selectedChatData._id : null,
        channelId: selectedChatType === "channel" ? selectedChatData._id : null,
      });
      isTypingRef.current = true;
    }

    if (!shouldEmitTyping && isTypingRef.current) {
      socket.emit("stop-typing", {
        chatType: selectedChatType,
        receiverId:
          selectedChatType === "contact" ? selectedChatData._id : null,
        channelId: selectedChatType === "channel" ? selectedChatData._id : null,
      });
      isTypingRef.current = false;
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    if (shouldEmitTyping) {
      typingTimeoutRef.current = setTimeout(() => {
        socket.emit("stop-typing", {
          chatType: selectedChatType,
          receiverId:
            selectedChatType === "contact" ? selectedChatData._id : null,
          channelId:
            selectedChatType === "channel" ? selectedChatData._id : null,
        });
        isTypingRef.current = false;
      }, 1500);
    }

    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [message, selectedChatData, selectedChatType, socket]);

  useEffect(() => {
    if (selectedChatType !== "contact" && replyToMessage) {
      clearReplyToMessage();
    }
  }, [selectedChatType, replyToMessage, clearReplyToMessage]);

  useEffect(() => {
    if (replyToMessage && inputRef.current) {
      inputRef.current.focus();
    }
  }, [replyToMessage]);

  useEffect(() => {
    return () => {
      if (!socket || !isTypingRef.current) return;
      socket.emit("stop-typing", {
        chatType: selectedChatType,
        receiverId:
          selectedChatType === "contact" ? selectedChatData?._id : null,
        channelId:
          selectedChatType === "channel" ? selectedChatData?._id : null,
      });
      isTypingRef.current = false;
    };
  }, [selectedChatData, selectedChatType, socket]);

  return (
    <div className="p-2 sm:p-3 safe-area-bottom bg-background">
      {/* Floating input bar - Telegram style */}
      <div className="input-bar relative">
        {selectedChatType === "contact" && replyToMessage && (
          <div className="absolute -top-12 left-2 right-2 sm:left-4 sm:right-4">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background-secondary/95 px-3 py-2 shadow-md">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">
                  Replying to {getReplySenderLabel()}
                </p>
                <p className="text-xs text-foreground-muted truncate">
                  {getReplyPreviewText()}
                </p>
              </div>
              <button
                onClick={clearReplyToMessage}
                className="touch-target rounded-full text-foreground-muted hover:text-foreground hover:bg-accent transition-colors"
                title="Cancel reply"
              >
                <IoCloseSharp className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
        {/* Attachment button */}
        <button
          onClick={handleAttachmentClick}
          className={cn(
            "touch-target rounded-full",
            "text-foreground-muted hover:text-foreground",
            "hover:bg-accent active:scale-95",
            "transition-all duration-200",
          )}
        >
          <CgAttachment className="w-5 h-5 sm:w-6 sm:h-6" />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={handleAttachmentChange}
        />

        {/* Message input */}
        <textarea
          ref={inputRef}
          className={cn(
            "flex-1 px-3 py-2 sm:py-2.5",
            "bg-transparent text-foreground",
            "placeholder:text-foreground-muted",
            "text-sm sm:text-base",
            "focus:outline-none",
            "min-w-0", // Prevent flex overflow
            "resize-none", // Prevent manual resize
            "max-h-32", // Limit max height
          )}
          placeholder="Type a message..."
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              if (Capacitor.isNativePlatform()) {
                // On mobile, let default behavior happen (insert newline)
              } else {
                // On web, send message
                e.preventDefault();
                handleSendMessage();
              }
            }
          }}
          rows={1}
        />

        {/* Emoji picker */}
        <div className="relative" ref={emojiRef}>
          <button
            onClick={() => setEmojiPickerOpen((state) => !state)}
            className={cn(
              "touch-target rounded-full",
              "text-foreground-muted hover:text-foreground",
              "hover:bg-accent active:scale-95",
              "transition-all duration-200",
              emojiPickerOpen && "text-primary",
            )}
          >
            <RiEmojiStickerLine className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>

          {/* Emoji picker dropdown */}
          <div
            className={cn(
              "absolute bottom-14 right-0 z-50",
              "animate-scale-in origin-bottom-right",
              !emojiPickerOpen && "hidden",
            )}
          >
            <Suspense fallback={<div className="flex items-center justify-center w-[300px] h-[400px] bg-background-secondary rounded-xl"><span className="text-foreground-muted text-sm">Loading...</span></div>}>
              <EmojiPicker
                theme="dark"
                onEmojiClick={(emojiObject) => handleAddEmoji(emojiObject)}
                autoFocusSearch={false}
                emojiStyle="native"
                searchPlaceHolder="Search emoji..."
                width={300}
                height={400}
              />
            </Suspense>
          </div>
        </div>

        {/* Send button */}
        <button
          onClick={handleSendMessage}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!message.trim()}
          className={cn(
            "touch-target rounded-full",
            "transition-all duration-200",
            message.trim()
              ? "text-primary hover:text-primary-hover hover:bg-primary/10 active:scale-95"
              : "text-foreground-muted cursor-not-allowed",
          )}
        >
          <IoSend className="w-5 h-5 sm:w-6 sm:h-6" />
        </button>
      </div>
    </div>
  );
};

export default MessageBar;
