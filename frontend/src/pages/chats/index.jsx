import React from "react";
import ContactContainer from "./components/ContactContainer";
import EmptyChatContainer from "./components/EmptyChatContainer";
import ChatContainer from "./components/ChatContainer";
import useAppStore from "@/store";

const Chats = () => {
  const { user, selectedChatType } = useAppStore();
  return (
    <div className="flex overflow-hidden h-[100vh] w-full text-white">
      <ContactContainer />
      {selectedChatType === undefined ? (
        <EmptyChatContainer />
      ) : (
        <ChatContainer />
      )}
    </div>
  );
};

export default Chats;
