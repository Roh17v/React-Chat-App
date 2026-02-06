import React, { useEffect, useRef, useState } from "react";
import { CgAttachment } from "react-icons/cg";
import { RiEmojiStickerLine } from "react-icons/ri";
import { IoSend } from "react-icons/io5";
import EmojiPicker from "emoji-picker-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { UPLOAD_FILE_ROUTE } from "@/utils/constants";
import { cn } from "@/lib/utils";

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
    addMessage,
    setFileUploadingProgress,
    setIsUploading,
  } = useAppStore();
  const { socket } = useSocket();

  const fileInputRef = useRef();

  const handleSendMessage = async () => {
    if (message.trim() === "") return;

    if (selectedChatType === "contact") {
      const newMessage = {
        sender: user.id,
        content: message,
        receiver: selectedChatData._id,
        messageType: "text",
        fileUrl: undefined,
      };
      socket.emit("sendMessage", newMessage);
    } else if (selectedChatType === "channel") {
      socket.emit("send-channel-message", {
        sender: user.id,
        content: message,
        messageType: "text",
        fileUrl: undefined,
        channelId: selectedChatData._id,
      });
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
    setMessage("");
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
            socket.emit("sendMessage", {
              sender: user.id,
              content: undefined,
              receiver: selectedChatData._id,
              messageType: "file",
              fileUrl: response.data.fileUrl,
            });
          } else if (selectedChatType === "channel") {
            socket.emit("send-channel-message", {
              sender: user.id,
              content: message,
              messageType: "file",
              fileUrl: response.data.fileUrl,
              channelId: selectedChatData._id,
            });
          }
        }
      }
    } catch (error) {
      console.log("Error sending file: ", error);
      setIsUploading(false);
    }
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
      <div className="input-bar">
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
        <input
          ref={inputRef}
          type="text"
          className={cn(
            "flex-1 px-3 py-2 sm:py-2.5",
            "bg-transparent text-foreground",
            "placeholder:text-foreground-muted",
            "text-sm sm:text-base",
            "focus:outline-none",
            "min-w-0", // Prevent flex overflow
          )}
          placeholder="Type a message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSendMessage();
            }
          }}
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
            <EmojiPicker
              theme="dark"
              onEmojiClick={(emojiObject) => handleAddEmoji(emojiObject)}
              autoFocusSearch={false}
              emojiStyle="native"
              searchPlaceHolder="Search emoji..."
              width={300}
              height={400}
            />
          </div>
        </div>

        {/* Send button */}
        <button
          onClick={handleSendMessage}
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
