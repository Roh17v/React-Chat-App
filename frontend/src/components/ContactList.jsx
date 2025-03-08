import useAppStore from "@/store";
import React from "react";
import { Avatar, AvatarImage } from "./ui/avatar";
import { HOST } from "@/utils/constants";
import { useSocket } from "@/context/SocketContext";

const ContactList = ({ contacts, isChannel = false }) => {
  const {
    selectedChatData,
    setSelectedChatData,
    setSelectedChatType,
    selectedChatType,
    setSelectedChatMessages,
  } = useAppStore();

  const { onlineUsers } = useSocket();

  const handleClick = (contact) => {
    if (isChannel) setSelectedChatType("channel");
    else setSelectedChatType("contact");
    setSelectedChatData(contact);
    if (selectedChatData && selectedChatData._id !== contact._id) {
      setSelectedChatMessages([]);
    }
  };

  return (
    <div className="mt-5 space-y-2">
      {contacts.map((contact) => (
        <div
          key={contact._id}
          onClick={() => handleClick(contact)}
          className={`flex items-center gap-4 p-3 rounded-lg transition-all duration-300 cursor-pointer ${
            selectedChatData && selectedChatData._id === contact._id
              ? "bg-[#8417ff] hover:bg-[#8417ff]"
              : "hover:bg-[#2a2b33]"
          }`}
        >
          {!isChannel && (
            <Avatar
              className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden border-2 border-[#3f404a] flex items-center justify-center"
              style={{
                backgroundColor: `${contact.color?.bgColor || "#ccc"}80`,
                color: `${contact.color?.textColor || "#fff"}`,
              }}
            >
              {contact.image ? (
                <AvatarImage
                  src={`${HOST}${contact.image}`}
                  alt="profile"
                  className="object-cover w-full h-full"
                />
              ) : (
                <span className="uppercase text-lg sm:text-xl font-semibold truncate">
                  {contact.firstName
                    ? contact.firstName.charAt(0)
                    : contact.email.charAt(0)}
                </span>
              )}
            </Avatar>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-neutral-200">
              {contact.firstName} {contact.lastName}
            </p>
            <p className="text-xs text-neutral-400 truncate">{contact.email}</p>
          </div>
          {onlineUsers.includes(contact._id) && (
            <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0"></div>
          )}
        </div>
      ))}
    </div>
  );
};

export default ContactList;
