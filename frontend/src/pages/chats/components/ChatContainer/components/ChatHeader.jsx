import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";
import React from "react";
import { RiCloseFill } from "react-icons/ri";
import { HOST } from "@/utils/constants";

const ChatHeader = () => {
  const { closeChat, selectedChatData, selectedChatType } = useAppStore();
  return (
    <div className="h-[10vh] border-b-2 border-[#2f303b] flex items-center justify-between">
      <div className="flex gap-5 items-center w-full justify-between mx-5">
        <div className="flex gap-4 items-center justify-between ">
          <div className="w-12 h-12 relative">
            <Avatar
              className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden border border-gray-500 flex items-center justify-center"
              style={{
                backgroundColor: `${
                  selectedChatData.color?.bgColor || "#ccc"
                }80`,
                color: `${selectedChatData.color?.textColor || "#fff"}`,
              }}
            >
              {selectedChatData.image ? (
                <AvatarImage
                  src={`${HOST}${selectedChatData.image}`}
                  alt="profile"
                  className="object-cover w-full h-full"
                />
              ) : (
                <span className="uppercase text-lg sm:text-xl font-semibold">
                  {selectedChatData.firstName
                    ? selectedChatData.firstName.charAt(0)
                    : selectedChatData.email.charAt(0)}
                </span>
              )}
            </Avatar>
          </div>
          <div>
            {selectedChatType === "contact" &&
              `${selectedChatData.firstName} ${selectedChatData.lastName}`}
          </div>
        </div>
        <div className="flex items-center justify-center gap-5">
          <button>
            <RiCloseFill onClick={closeChat} className="text-3xl" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatHeader;
