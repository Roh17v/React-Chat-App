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
    page,
    setPage,
  } = useAppStore();

  const [showImage, setShowImage] = useState(false);
  const [imageURL, setImageURL] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const containerRef = useRef(null);
  const newMessageRef = useRef(null);

  const getMessages = async (pageNumber = 1) => {
    if (!selectedChatData?._id || loading || !hasMore) return;

    const container = containerRef.current;

    setLoading(true);
    try {
      const response = await axios.get(
        `${HOST}${PRIVATE_CONTACT_MESSAGES_ROUTE}/${selectedChatData._id}?page=${pageNumber}&limit=20`,
        {
          withCredentials: true,
        }
      );

      if (response.data.length === 0) setHasMore(false);
      console.log(response.data);

      setSelectedChatMessages(response.data, false);

      if (containerRef.current && pageNumber === 1) {
        requestAnimationFrame(() => {
          containerRef.current.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: "smooth",
          });
        });
      }

      console.log(selectedChatMessages);

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  const getChannelMessages = async (pageNumber = 1) => {
    if (!selectedChatData?._id || loading || !hasMore) return;
    setLoading(true);

    try {
      const response = await axios.get(
        `${HOST}${CHANNEL_MESSAGES_ROUTE}/${selectedChatData._id}?page=${pageNumber}&limit=20`,
        {
          withCredentials: true,
        }
      );
      if (response.data.length === 0) setHasMore(false);
      console.log(response.data);

      setSelectedChatMessages(response.data, false);

      if (containerRef.current && pageNumber === 1) {
        requestAnimationFrame(() => {
          containerRef.current.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: "smooth",
          });
        });
      }

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedChatData._id) {
      if (selectedChatType === "contact") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getMessages(1, true);
      }
      if (selectedChatType === "channel") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getChannelMessages(1, true);
      }
    }
  }, [selectedChatData, selectedChatType, setSelectedChatMessages]);

  const messagesRef = useRef(new Map());

  const renderMessages = () => {
    let lastDate = null;
    return selectedChatMessages.map((message, index) => {
      const messageDate = moment(message.createdAt).format("YYYY-MM-DD");
      const showDate = messageDate !== lastDate;
      lastDate = messageDate;

      if (!messagesRef.current.has(message._id)) {
        messagesRef.current.set(message._id, message);
      }

      return (
        <div
          key={message._id}
          ref={index === selectedChatMessages.length - 1 ? newMessageRef : null}
        >
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
                ? "bg-[#8427ff]/5 text-[#A78BFA] /90 border-[#A78BFA]/50"
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
                ? "bg-[#8427ff]/5 text-[#A78BFA]/90 border-[#A78BFA]/50"
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
                ? "bg-[#8427ff]/5 text-[#A78BFA]/90 border-[#A78BFA]/50"
                : "bg-[#2a2b33]/5 text-[#ffffff]/90 border-[#ffffff]/20"
            } border inline-block rounded my-1 max-w-[50%] break-words p-2`}
          >
            {message.sender && (
              <p className="text-xs text-gray-400 font-medium mb-1 text-left">
                {message.sender?.firstName} {message.sender?.lastName}
              </p>
            )}
            {message.content}
          </div>
        )}
        {message.messageType === "file" && (
          <div
            className={`${
              message.sender._id === user.id
                ? "bg-[#8427ff]/5 text-[#A78BFA]/90 border-[#A78BFA]/50"
                : "bg-[#2a2b33]/5 text-[#ffffff]/90 border-[#ffffff]/20"
            } border inline-block rounded my-1 max-w-[50%] break-words p-2`}
          >
            {message.sender && (
              <p className="text-xs text-gray-400 font-medium mb-1 text-left">
                {message.sender?.firstName} {message.sender?.lastName}
              </p>
            )}
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

  const handleScroll = () => {
    if (!containerRef.current || loading || !hasMore) return;

    const scrollYBeforeFetch = containerRef.current.scrollHeight;

    if (containerRef.current.scrollTop < 50) {
      if (selectedChatType === "contact") {
        getMessages(page + 1).then(() => {
          requestAnimationFrame(() => {
            containerRef.current.scrollTop =
              containerRef.current.scrollHeight - scrollYBeforeFetch;
          });
        });
      } else if (selectedChatType === "channel") {
        getChannelMessages(page + 1).then(() => {
          requestAnimationFrame(() => {
            containerRef.current.scrollTop =
              containerRef.current.scrollHeight - scrollYBeforeFetch;
          });
        });
      }
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isNearBottom =
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 400;

    if (isNearBottom && newMessageRef.current) {
      newMessageRef.current.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
  }, [selectedChatMessages]);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll);
    }
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto h-[calc(100vh-10rem)] scrollbar-hidden p-4 px-8 md:w-[65vw] lg:w-[70vw] xl:w-[80vw] w-full"
    >
      {loading && (
        <div className="text-center py-2">
          <span className="animate-spin inline-block w-6 h-6 border-4 border-purple-500 border-t-transparent rounded-full"></span>
        </div>
      )}
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
