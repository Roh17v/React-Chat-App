import useAppStore from "@/store";
import React from "react";
import { Avatar, AvatarImage } from "./ui/avatar";
import { useSocket } from "@/context/SocketContext";

const ContactList = ({ contacts, isChannel = false }) => {
  const { socket } = useSocket();
  const {
    selectedChatData,
    setSelectedChatData,
    setSelectedChatType,
    setSelectedChatMessages,
    setPage,
    user,
  } = useAppStore();

  const { onlineUsers } = useSocket();

  const handleClick = (contact) => {
    setSelectedChatType(isChannel ? "channel" : "contact");
    setSelectedChatData(contact);
    contact.unreadCount = 0;
    socket.emit("confirm-read", { userId: user.id, senderId: contact._id });
    if (selectedChatData && selectedChatData._id !== contact._id) {
      setSelectedChatMessages([], true);
      setPage(1);
    }
  };

  const isSelected = (contact) =>
    selectedChatData && selectedChatData._id === contact._id;

  const isOnline = (contact) => onlineUsers?.includes(contact._id);

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
              <span className="text-foreground font-medium text-sm truncate">
                {isChannel
                  ? contact.channelName
                  : `${contact.firstName || ""} ${contact.lastName || ""}`.trim() ||
                    contact.email}
              </span>
              {/* Timestamp placeholder - you can add lastMessageTime here */}
              {contact.lastMessageTime && (
                <span className="text-foreground-muted text-xs flex-shrink-0">
                  {contact.lastMessageTime}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 mt-0.5">
              {/* Last message preview */}
              <p className="text-foreground-muted text-xs truncate">
                {contact.lastMessage ||
                  (isChannel
                    ? `${contact.members?.length || 0} members`
                    : contact.email)}
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
