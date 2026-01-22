import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";
import React from "react";
import { RiCloseFill } from "react-icons/ri";
import { useSocket } from "@/context/SocketContext";
import { IoCall, IoVideocam } from "react-icons/io5";

const ChatHeader = () => {
  // 1. Get 'setActiveCall' from the store
  const { closeChat, selectedChatData, selectedChatType, setActiveCall } =
    useAppStore();
  const { socket } = useSocket();

  const initiateCall = (callType) => {
    if (!selectedChatData?._id) return;

    // 2. Emit the event to the server
    socket.emit("call:initiate", {
      receiverId: selectedChatData._id,
      callType, // "audio" | "video"
    });

    // 3. CRITICAL FIX: Update Local State Immediately
    // This triggers the VideoCallScreen to mount with isCaller = true
    setActiveCall({
      callType,
      isCaller: true, // This enables the "Calling..." UI
      otherUserId: selectedChatData._id,
      otherUserName: `${selectedChatData.firstName} ${selectedChatData.lastName}`,
      otherUserImage: selectedChatData.image,
    });
  };

  return (
    <div className="h-[10vh] border-b-2 border-[#2f303b] flex items-center justify-between">
      <div className="flex gap-5 items-center w-full justify-between mx-5">
        <div className="flex gap-4 items-center justify-between ">
          <div className="w-12 h-12 relative">
            {selectedChatType === "contact" ? (
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
                    src={`${selectedChatData.image}`}
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
            ) : (
              <Avatar
                className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden border border-gray-500 flex items-center justify-center"
                style={{
                  backgroundColor: "#ffffff22",
                  color: `#e5e5e5`,
                }}
              >
                {selectedChatData.image ? (
                  <AvatarImage
                    src={`${selectedChatData.image}`}
                    alt="profile"
                    className="object-cover w-full h-full"
                  />
                ) : (
                  <span className="uppercase text-lg sm:text-xl font-semibold">
                    {selectedChatData.channelName &&
                      selectedChatData.channelName.charAt(0)}
                  </span>
                )}
              </Avatar>
            )}
          </div>
          <div>
            {selectedChatType === "contact" &&
              `${selectedChatData.firstName} ${selectedChatData.lastName}`}
            {selectedChatType === "channel" && selectedChatData.channelName}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 md:gap-4">
          {selectedChatType === "contact" && (
            <>
              <button
                onClick={() => initiateCall("audio")}
                title="Audio Call"
                className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-full hover:text-green-400 transition"
              >
                <IoCall className="text-lg sm:text-xl" />
              </button>

              <button
                onClick={() => initiateCall("video")}
                title="Video Call"
                className="flex items-center justify-center w-12 h-12 sm:w-10 sm:h-10 rounded-full hover:text-green-400 transition"
              >
                <IoVideocam className="text-lg sm:text-xl" />
              </button>
            </>
          )}
          <button
            onClick={closeChat}
            title="Close Chat"
            className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-full transition"
          >
            <RiCloseFill className="text-xl sm:text-2xl" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatHeader;
