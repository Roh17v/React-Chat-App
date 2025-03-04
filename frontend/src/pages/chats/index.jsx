import React from "react";
import ContactContainer from "./components/ContactContainer";
import EmptyChatContainer from "./components/EmptyChatContainer";
import ChatContainer from "./components/ChatContainer";

const Chats = () => {
  return (
    <div className="flex overflow-hidden h-[100vh] w-full text-white">
      <ContactContainer />
      {/* <EmptyChatContainer /> */}
      {/* <ChatContainer /> */}
    </div>
  );
};

export default Chats;
