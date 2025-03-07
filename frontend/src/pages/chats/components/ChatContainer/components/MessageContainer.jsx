import useAppStore from "@/store";
import { HOST, MESSAGES_ROUTE } from "@/utils/constants";
import moment from "moment";
import React, { useEffect, useRef } from "react";
import axios from "axios";

const MessageContainer = () => {
  const scrollRef = useRef();
  const {
    selectedChatType,
    selectedChatData,
    user,
    selectedChatMessages,
    setSelectedChatData,
    setSelectedChatMessages,
  } = useAppStore();

  useEffect(() => {
    const getMessages = async () => {
      try {
        const response = await axios.get(
          `${HOST}${MESSAGES_ROUTE}/${selectedChatData._id}`,
          {
            withCredentials: true,
          }
        );
        console.log(response.data);
        setSelectedChatMessages(response.data);
      } catch (error) {
        console.log(error);
      }
    };
    if (selectedChatData._id) {
      if (selectedChatType === "contact") getMessages();
    }
  }, [selectedChatData, selectedChatType, setSelectedChatMessages]);

  const renderMessages = () => {
    let lastDate = null;
    return selectedChatMessages.map((message) => {
      const messageDate = moment(message.createdAt).format("YYYY-MM-DD");
      const showDate = messageDate !== lastDate;
      lastDate = messageDate;
      return (
        <div key={message._id}>
          {showDate && (
            <div className="text-center text-gray-500 my-2">
              {moment(message.createdAt).format("LL")}
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
        id={message._id}
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
          </div>
        )}
        <div className="text-xs text-gray-500 ">
          {moment(message.createdAt).format("LT")}
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [selectedChatMessages]);
  return (
    <div className="flex-1 overflow-y-auto h-[calc(100vh-10rem)] scrollbar-hidden p-4 px-8 md:w-[65vw] lg:w-[70vw] xl:w-[80vw] w-full">
      {renderMessages()}
      <div ref={scrollRef}></div>
    </div>
  );
};

export default MessageContainer;
