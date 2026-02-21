import useAppStore from "@/store";
import React from "react";
import { Avatar, AvatarImage } from "./ui/avatar";
import { useSocket } from "@/context/SocketContext";
import moment from "moment";

const ContactList = ({ contacts, isChannel = false }) => {
  const { socket } = useSocket();
  const {
    selectedChatData,
    setSelectedChatData,
    setSelectedChatType,
    setSelectedChatMessages,
    setPage,
    user,
    resetUnreadCount,
  } = useAppStore();

  const { onlineUsers } = useSocket();

  const handleClick = (contact) => {
    setSelectedChatType(isChannel ? "channel" : "contact");
    setSelectedChatData(contact);
    if (!isChannel) {
      resetUnreadCount(contact._id);
      socket.emit("confirm-read", { userId: user.id, senderId: contact._id });
    }
    if (selectedChatData && selectedChatData._id !== contact._id) {
      setSelectedChatMessages([], true);
      setPage(1);
    }
  };

  const isSelected = (contact) =>
    selectedChatData && selectedChatData._id === contact._id;

  const isOnline = (contact) => onlineUsers?.includes(contact._id);

  const formatMessageTime = (value) => {
    if (!value) return "";
    const time = moment(value);
    if (!time.isValid()) return "";
    if (time.isSame(moment(), "day")) return time.format("h:mm A");
    if (time.isSame(moment().subtract(1, "day"), "day")) return "Yesterday";
    if (time.isSame(moment(), "year")) return time.format("MMM D");
    return time.format("DD/MM/YY");
  };

  const getDmPreview = (contact) => {
    const preview = (contact.lastMessage || "").trim();
    if (preview) return preview;
    return "No messages yet";
  };

  if (!contacts || contacts.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-foreground-muted text-sm">
          {isChannel ? "No channels yet" : "No conversations yet"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {contacts.map((contact) => (
        <button
          key={contact._id}
          onClick={() => handleClick(contact)}
          className={`w-full contact-item ${isSelected(contact) ? "active bg-accent" : ""}`}
        >
          {/* Avatar with status */}
          <div className="relative flex-shrink-0">
            <Avatar className="h-12 w-12 ring-2 ring-border">
              {contact.image ? (
                <AvatarImage
                  src={contact.image}
                  alt="avatar"
                  className="object-cover"
                />
              ) : (
                <div
                  className={`flex h-full w-full items-center justify-center rounded-full font-semibold text-base ${
                    isChannel ? "bg-primary text-primary-foreground" : ""
                  }`}
                  style={
                    !isChannel
                      ? {
                          backgroundColor: `${contact.color?.bgColor || "var(--muted)"}80`,
                          color:
                            contact.color?.textColor || "var(--foreground)",
                        }
                      : {}
                  }
                >
                  {isChannel
                    ? contact.channelName?.charAt(0).toUpperCase() || "#"
                    : contact.firstName
                      ? contact.firstName.charAt(0).toUpperCase()
                      : contact.email?.charAt(0).toUpperCase()}
                </div>
              )}
            </Avatar>
            {/* Online status indicator */}
            {!isChannel && isOnline(contact) && (
              <span className="status-dot online" />
            )}
          </div>

          {/* Contact info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground font-medium text-sm truncate pr-2">
                {isChannel
                  ? contact.channelName
                  : `${contact.firstName || ""} ${contact.lastName || ""}`.trim() ||
                    contact.email}
              </span>
              {!isChannel && contact.lastMessageAt && (
                <span className="text-foreground-muted text-[11px] sm:text-xs flex-shrink-0">
                  {formatMessageTime(contact.lastMessageAt)}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 mt-0.5">
              {/* Last message preview */}
              <p
                className={`text-xs truncate leading-5 ${
                  !isChannel && contact?.unreadCount > 0
                    ? "text-foreground"
                    : "text-foreground-muted"
                }`}
              >
                {isChannel
                  ? `${contact.members?.length || 0} members`
                  : getDmPreview(contact)}
              </p>

              {/* Unread badge */}
              {!isChannel && contact?.unreadCount > 0 && (
                <span className="unread-badge flex-shrink-0">
                  {contact.unreadCount > 99 ? "99+" : contact.unreadCount}
                </span>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
};

export default ContactList;
