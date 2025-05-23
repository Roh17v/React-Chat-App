import React, { useEffect, useRef } from "react";
import { CgAttachment } from "react-icons/cg";
import { useState } from "react";
import { RiEmojiStickerLine } from "react-icons/ri";
import { IoSend } from "react-icons/io5";
import EmojiPicker from "emoji-picker-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { UPLOAD_FILE_ROUTE } from "@/utils/constants";

const MessageBar = () => {
  const [message, setMessage] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiRef = useRef();
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
              Math.round((100 * data.loaded) / data.total)
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
              fileUrl: response.data.filePath,
            });
          } else if (selectedChatType === "channel") {
            socket.emit("send-channel-message", {
              sender: user.id,
              content: message,
              messageType: "file",
              fileUrl: response.data.filePath,
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
  return (
    <div className="min-h-[60px] sm:h-[10vh] w-full bg-[#1c1d25] flex justify-center items-center px-4 sm:px-8 gap-2 sm:gap-6 mb-4 sm:mb-6">
      <div className="flex-1 flex bg-[#2a2b33] rounded-md items-center gap-2 sm:gap-5 pr-3 sm:pr-5 flex-wrap">
        <input
          type="text"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSendMessage();
            }
          }}
          className="flex-1 p-3 sm:p-5 bg-transparent rounded-md focus:border-none focus:outline-none"
          placeholder="Enter message..."
          onChange={(e) => setMessage(e.target.value)}
          value={message}
        />
        <button className="text-neutral-500 focus:border-none focus:outline-none focus:text-white duration-300 transition-all">
          <CgAttachment onClick={handleAttachmentClick} />
        </button>
        <input
          type="file"
          className="hidden"
          ref={fileInputRef}
          onChange={handleAttachmentChange}
        />
        <div className="relative" ref={emojiRef}>
          <button
            className="text-neutral-500 focus:border-none focus:outline-none focus:text-white duration-300 transition-all"
            onClick={() => setEmojiPickerOpen((state) => !state)}
          >
            <RiEmojiStickerLine />
          </button>
          <div className="absolute bottom-14 sm:bottom-16 right-4 sm:right-8">
            <EmojiPicker
              theme="dark"
              open={emojiPickerOpen}
              onEmojiClick={(emojiObject) => handleAddEmoji(emojiObject)}
              autoFocusSearch={false}
            />
          </div>
        </div>
      </div>
      <button
        onClick={handleSendMessage}
        className="bg-[#8417ff] rounded-md flex items-center justify-center focus:border-none p-3 sm:p-5 hover:bg-[#741bda] focus:bg-[#741bda] duration-300 transition-all"
      >
        <IoSend className="text-xl sm:text-2xl" />
      </button>
    </div>
  );
};

export default MessageBar;
