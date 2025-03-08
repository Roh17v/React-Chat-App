import React, { useEffect, useRef } from "react";
import { CgAttachment } from "react-icons/cg";
import { useState } from "react";
import { RiEmojiStickerLine } from "react-icons/ri";
import { IoSend } from "react-icons/io5";
import EmojiPicker from "emoji-picker-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";

const MessageBar = () => {
  const [message, setMessage] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiRef = useRef();
  const { selectedChatType, selectedChatData, user, addMessage } =
    useAppStore();
  const { socket } = useSocket();

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

      setMessage("");
    }
  };

  const handleAddEmoji = (emoji) => {
    setMessage((mssg) => mssg + emoji.emoji);
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
    <div className="h-[10vh] bg-[#1c1d25] flex justify-center items-center px-8 gap-6 mb-6">
      <div className="flex-1 flex bg-[#2a2b33] rounded-md items-center gap-5 pr-5">
        <input
          type="text"
          className="flex-1 p-5 bg-transparent rounded-md focus:border-none focus:outline-none"
          placeholder="Enter message..."
          onChange={(e) => setMessage(e.target.value)}
          value={message}
        />
        <button className="text-neutral-500 focus:border-none focus:outline-none focus:text-white duration-300 transition-all">
          <CgAttachment />
        </button>
        <div className="relative" ref={emojiRef}>
          <button
            className="text-neutral-500 focus:border-none focus:outline-none focus:text-white duration-300 transition-all"
            onClick={() => setEmojiPickerOpen((state) => !state)}
          >
            <RiEmojiStickerLine />
          </button>
          <div className="absolute bottom-16 right-8">
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
        className="bg-[#8417ff] rounded-md flex items-center justify-center focus:border-none p-5 hover:bg-[#741bda] focus:bg-[#741bda] duration-300 transition-all"
      >
        <IoSend className="text-2xl" />
      </button>
    </div>
  );
};

export default MessageBar;
