import useAppStore from "@/store";
import moment from "moment";
import React, { useEffect, useRef } from "react";

const MessageContainer = () => {
  const scrollRef = useRef();
  const { selectedChatType, selectedChatData, user, selectedChatMessages } =
    useAppStore();
  const renderMessages = () => {
    let lastDate = null;
    return selectedChatMessages.map((message) => {
      const messageDate = moment(message.timestamp).format("YYYY-MM-DD");
      const showDate = messageDate !== lastDate;
      lastDate = messageDate;
      return (
        <div key={message._id}>
          {showDate && (
            <div className="text-center text-gray-500 my-2">
              {moment(message.timestamp).format("LL")}
            </div>
          )}
          {selectedChatType === "contact" && renderDMMessages(message)}
        </div>
      );
    });
  };

  const renderDMMessages = (message) => {
    return (
      <div
        id={message.sender}
        className={`${message.sender === user.id ? "text-right" : "text-left"}`}
      >
        {message.messageType === "text" && (
          <div
            className={`${
              message.sender !== selectedChatData._id
                ? "bg-[#8427ff]/5 text-[#8427ff]/90 border-[#8427ff]/50"
                : "bg-[#2a2b33]/5 text-[#ffffff]/90 border-[#ffffff]/20"
            } border inline-block rounded my-1 max-w-[50%] break-words p-2`}
          >
            {message.content}
            {message.sender._id === user._id}
          </div>
        )}
        <div className="text-xs text-gray-500 ">
          {moment(message.timestamp).format("LT")}
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [selectedChatMessages]);
  return (
    <div className="flex-1 overflow-hidden y-auto scrollbar-hidden p-4 px-8 md:w-[65vw] lg:w-[70vw] xl:w-[80vw] w-full">
      {renderMessages()}
      <div ref={scrollRef}></div>
    </div>
  );
};

export default MessageContainer;
