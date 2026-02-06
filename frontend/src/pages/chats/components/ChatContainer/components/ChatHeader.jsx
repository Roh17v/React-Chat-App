import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";
import React, { useState } from "react";
import { RiCloseFill } from "react-icons/ri";
import { useSocket } from "@/context/SocketContext";
import { IoCall, IoVideocam, IoCloseSharp } from "react-icons/io5";

const ChatHeader = () => {
  const { closeChat, selectedChatData, selectedChatType, setActiveCall } =
    useAppStore();
  const { socket, onlineUsers } = useSocket();
  const [showAvatarPreview, setShowAvatarPreview] = useState(false);

  const initiateCall = (callType) => {
    if (!selectedChatData?._id) return;

    socket.emit("call:initiate", {
      receiverId: selectedChatData._id,
      callType,
    });

    setActiveCall({
      callType,
      isCaller: true,
      otherUserId: selectedChatData._id,
      otherUserName: `${selectedChatData.firstName} ${selectedChatData.lastName}`,
      otherUserImage: selectedChatData.image,
    });
  };

  const getAvatarImage = () => {
    return selectedChatData?.image || null;
  };

  const getAvatarFallback = () => {
    if (selectedChatType === "contact") {
      return selectedChatData?.firstName
        ? selectedChatData.firstName.charAt(0).toUpperCase()
        : selectedChatData?.email?.charAt(0).toUpperCase() || "?";
    }
    return selectedChatData?.channelName?.charAt(0).toUpperCase() || "#";
  };

  const getDisplayName = () => {
    if (selectedChatType === "contact") {
      return `${selectedChatData?.firstName || ""} ${selectedChatData?.lastName || ""}`.trim();
    }
    return selectedChatData?.channelName || "Channel";
  };

  const contactIsOnline = onlineUsers?.includes(selectedChatData._id);

  const formatLastSeen = (value) => {
    if (!value) return "Last seen recently";
    const lastSeenDate = new Date(value);
    if (Number.isNaN(lastSeenDate.getTime())) return "Last seen recently";

    const now = new Date();
    const diffMs = now - lastSeenDate;
    if (diffMs <= 60 * 1000) return "Last seen just now";

    const isSameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();

    const timeFormatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const timeText = timeFormatter.format(lastSeenDate);

    if (isSameDay(lastSeenDate, now)) {
      return `Last seen today at ${timeText}`;
    }

    const yesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
    );
    if (isSameDay(lastSeenDate, yesterday)) {
      return `Last seen yesterday at ${timeText}`;
    }

    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `Last seen on ${dateFormatter.format(lastSeenDate)} at ${timeText}`;
  };

  const getStatusText = () => {
    if (selectedChatType !== "contact") {
      return `${selectedChatData?.members?.length || 0} members`;
    }
    if (contactIsOnline) return "Online";
    return formatLastSeen(selectedChatData?.lastSeen);
  };

  return (
    <>
      {/* Header */}
      <div className="h-16 sm:h-[72px] border-b border-border bg-background-secondary/95 backdrop-blur-sm flex items-center justify-between px-3 sm:px-4 md:px-6 safe-area-top">
        <div className="flex items-center gap-3">
          {/* Avatar - Clickable */}
          <button
            onClick={() => setShowAvatarPreview(true)}
            className="relative flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background-secondary rounded-full transition-transform active:scale-95"
          >
            <Avatar className="h-10 w-10 sm:h-11 sm:w-11 ring-2 ring-border">
              {getAvatarImage() ? (
                <AvatarImage
                  src={getAvatarImage()}
                  alt="avatar"
                  className="object-cover"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center rounded-full font-semibold text-base sm:text-lg"
                  style={{
                    backgroundColor: `${selectedChatData?.color?.bgColor || "var(--muted)"}80`,
                    color:
                      selectedChatData?.color?.textColor || "var(--foreground)",
                  }}
                >
                  {getAvatarFallback()}
                </div>
              )}
            </Avatar>
            {/* Online status dot for contacts */}
            {selectedChatType === "contact" && contactIsOnline && (
              <span className="status-dot online" />
            )}
          </button>

          {/* Name and status */}
          <div className="flex flex-col min-w-0">
            <span className="text-foreground font-semibold text-sm sm:text-base truncate max-w-[150px] sm:max-w-[200px] md:max-w-none">
              {getDisplayName()}
            </span>
            <span className="text-foreground-muted text-xs">
              {getStatusText()}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 sm:gap-2">
          {selectedChatType === "contact" && (
            <>
              <button
                onClick={() => initiateCall("audio")}
                title="Audio Call"
                className="touch-target rounded-full text-foreground-secondary hover:text-primary hover:bg-accent transition-all duration-200 active:scale-95"
              >
                <IoCall className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
              <button
                onClick={() => initiateCall("video")}
                title="Video Call"
                className="touch-target rounded-full text-foreground-secondary hover:text-primary hover:bg-accent transition-all duration-200 active:scale-95"
              >
                <IoVideocam className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            </>
          )}
          <button
            onClick={closeChat}
            title="Close Chat"
            className="touch-target rounded-full text-foreground-secondary hover:text-destructive hover:bg-destructive/10 transition-all duration-200 active:scale-95"
          >
            <RiCloseFill className="w-6 h-6 sm:w-7 sm:h-7" />
          </button>
        </div>
      </div>

      {/* Avatar Preview Modal */}
      {showAvatarPreview && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm animate-fade-in"
          onClick={() => setShowAvatarPreview(false)}
        >
          {/* Avatar container */}
          <div
            className="relative animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Inside the Avatar Preview Modal logic */}
            {getAvatarImage() ? (
              <img
                src={getAvatarImage()}
                alt={getDisplayName()}
                className="max-w-[85vw] max-h-[70vh] sm:max-w-[400px] sm:max-h-[400px] rounded-2xl object-cover shadow-chat-lg"
              />
            ) : (
              <div
                className="w-64 h-64 sm:w-80 sm:h-80 rounded-2xl flex items-center justify-center shadow-chat-lg"
                style={{
                  backgroundColor:
                    selectedChatData?.color?.bgColor || "var(--primary)",
                  color:
                    selectedChatData?.color?.textColor ||
                    "var(--primary-foreground)",
                }}
              >
                <span className="text-7xl sm:text-8xl font-bold">
                  {getAvatarFallback()}
                </span>
              </div>
            )}

            {/* Name overlay */}
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent rounded-b-2xl">
              <p className="text-foreground text-lg sm:text-xl font-semibold text-center">
                {getDisplayName()}
              </p>
              {selectedChatType === "channel" && (
                <p className="text-foreground-muted text-sm text-center mt-1">
                  {selectedChatData?.members?.length || 0} members
                </p>
              )}
            </div>
          </div>

          {/* Close button */}
          <button
            onClick={() => setShowAvatarPreview(false)}
            className="absolute top-4 right-4 sm:top-6 sm:right-6 touch-target rounded-full bg-background-secondary/80 text-foreground hover:bg-background-tertiary transition-colors"
          >
            <IoCloseSharp className="w-6 h-6" />
          </button>
        </div>
      )}
    </>
  );
};

export default ChatHeader;
