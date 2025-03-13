import useAppStore from "@/store";
import {
  CHANNEL_MESSAGES_ROUTE,
  HOST,
  MESSAGES_ROUTE,
  PRIVATE_CONTACT_MESSAGES_ROUTE,
} from "@/utils/constants";
import moment from "moment";
import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import { MdFolderZip } from "react-icons/md";
import { IoArrowDownCircle, IoCloseSharp } from "react-icons/io5";

const MessageContainer = () => {
  const scrollRef = useRef();
  const {
    selectedChatType,
    selectedChatData,
    user,
    selectedChatMessages,
    setSelectedChatData,
    setSelectedChatMessages,
    setIsDownloading,
    setFileDownloadingProgress,
  } = useAppStore();

  const [showImage, setShowImage] = useState(false);
  const [imageURL, setImageURL] = useState(null);
  useEffect(() => {
    const getMessages = async () => {
      try {
        const response = await axios.get(
          `${HOST}${PRIVATE_CONTACT_MESSAGES_ROUTE}/${selectedChatData._id}`,
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

    const getChannelMessages = async () => {
      try {
        const response = await axios.get(
          `${HOST}${CHANNEL_MESSAGES_ROUTE}/${selectedChatData._id}`,
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
      if (selectedChatType === "channel") getChannelMessages();
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
          {selectedChatType === "channel" && renderChannelMessage(message)}
        </div>
      );
    });
  };

  const checkIfImage = (filePath) => {
    const imageRegex =
      /\.(jpg|jpeg|png|gif|bmp|tiff|tif|webp|svg|ico|heic|heif)$/i;
    return imageRegex.test(filePath);
  };

  const downloadFile = async (url) => {
    try {
      setIsDownloading(true);
      setFileDownloadingProgress(0);
      const response = await axios.get(`${HOST}/${url}`, {
        responseType: "blob",
        onDownloadProgress: (data) =>
          setFileDownloadingProgress(
            Math.round((100 * data.loaded) / data.total)
          ),
      });

      setIsDownloading(false);

      const urlBlob = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = urlBlob;
      link.setAttribute("download", url.split("/").pop());

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(urlBlob);
    } catch (error) {
      console.log("Error downloading file: ", error);
      setIsDownloading(false);
    }
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
        {message.messageType === "file" && (
          <div
            className={`${
              message.sender !== selectedChatData._id
                ? "bg-[#8427ff]/5 text-[#8427ff]/90 border-[#8427ff]/50"
                : "bg-[#2a2b33]/5 text-[#ffffff]/90 border-[#ffffff]/20"
            } border inline-block rounded my-1 max-w-[50%] break-words p-2`}
          >
            {checkIfImage(message.fileUrl.split("/").pop()) ? (
              <div
                className="cursor-pointer"
                onClick={() => {
                  setShowImage(true);
                  setImageURL(message.fileUrl);
                }}
              >
                <img
                  src={`${HOST}/${message.fileUrl}`}
                  height={300}
                  width={300}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center gap-4">
                <span className="text-white text-3xl bg-black/20 rounded-full p-3">
                  <MdFolderZip />
                </span>
                <span>{message.fileUrl.split("/").pop()}</span>
                <span className="bg-black/20 p-3 text-2xl rounded-full hover:bg-black/50 cursor-pointer transition-all duration-300">
                  <IoArrowDownCircle
                    onClick={() => downloadFile(message.fileUrl)}
                  />
                </span>
              </div>
            )}
          </div>
        )}
        <div className="text-xs text-gray-500 ">
          {moment(message.createdAt).format("LT")}
        </div>
      </div>
    );
  };

  const renderChannelMessage = (message) => {
    console.log(message.sender._id, user.id);
    return (
      <div
        className={`mt-5 ${
          message.sender._id === user.id ? "text-right" : "text-left"
        }`}
      >
        {message.messageType === "text" && (
          <div
            className={`${
              message.sender._id === user.id
                ? "bg-[#8427ff]/5 text-[#8427ff]/90 border-[#8427ff]/50"
                : "bg-[#2a2b33]/5 text-[#ffffff]/90 border-[#ffffff]/20"
            } border inline-block rounded my-1 max-w-[50%] break-words p-2`}
          >
            {message.content}
          </div>
        )}
        {message.messageType === "file" && (
          <div
            className={`${
              message.sender._id === user.id
                ? "bg-[#8427ff]/5 text-[#8427ff]/90 border-[#8427ff]/50"
                : "bg-[#2a2b33]/5 text-[#ffffff]/90 border-[#ffffff]/20"
            } border inline-block rounded my-1 max-w-[50%] break-words p-2`}
          >
            {checkIfImage(message.fileUrl.split("/").pop()) ? (
              <div
                className="cursor-pointer"
                onClick={() => {
                  setShowImage(true);
                  setImageURL(message.fileUrl);
                }}
              >
                <img
                  src={`${HOST}/${message.fileUrl}`}
                  height={300}
                  width={300}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center gap-4">
                <span className="text-white text-3xl bg-black/20 rounded-full p-3">
                  <MdFolderZip />
                </span>
                <span>{message.fileUrl.split("/").pop()}</span>
                <span className="bg-black/20 p-3 text-2xl rounded-full hover:bg-black/50 cursor-pointer transition-all duration-300">
                  <IoArrowDownCircle
                    onClick={() => downloadFile(message.fileUrl)}
                  />
                </span>
              </div>
            )}
          </div>
        )}
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
      {showImage && (
        <div className="fixed z-[1000] top-0 left-0 h-[100vh] w-[100vw] flex items-center justify-center backdrop-blur-lg flex-col">
          <div>
            <img src={`${HOST}/${imageURL}`} />
          </div>
          <div className="flex gap-5 fixed top-0 mt-5">
            <button className="bg-black/20 p-3 text-2xl rounded-full hover:bg-black/50 cursor-pointer transition-all duration-300">
              <IoArrowDownCircle onClick={() => downloadFile(imageURL)} />
            </button>

            <button className="bg-black/20 p-3 text-2xl rounded-full hover:bg-black/50 cursor-pointer transition-all duration-300">
              <IoCloseSharp
                onClick={() => {
                  setImageURL(null);
                  setShowImage(false);
                }}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageContainer;
