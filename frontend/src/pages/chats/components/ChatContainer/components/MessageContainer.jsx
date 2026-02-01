import useAppStore from "@/store";
import {
  CHANNEL_MESSAGES_ROUTE,
  HOST,
  MESSAGES_ROUTE,
  PRIVATE_CONTACT_MESSAGES_ROUTE,
} from "@/utils/constants";
import moment from "moment";
import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { MdFolderZip } from "react-icons/md";
import { IoArrowDownCircle, IoCloseSharp } from "react-icons/io5";
import { IoMdDoneAll } from "react-icons/io";
import { MdDone } from "react-icons/md";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const MessageContainer = () => {
  const scrollRef = useRef(null);
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
  const [showScrollButton, setShowScrollButton] = useState(false);
  const containerRef = useRef(null);
  const newMessageRef = useRef(null);
  const isInitialLoad = useRef(true);

  // Smooth scroll to bottom function
  const scrollToBottom = useCallback((smooth = true) => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }, []);

  const getMessages = async (pageNumber = 1) => {
    if (!selectedChatData?._id || loading || !hasMore) return;

    setLoading(true);
    try {
      const response = await axios.get(
        `${HOST}${PRIVATE_CONTACT_MESSAGES_ROUTE}/${selectedChatData._id}?page=${pageNumber}&limit=20`,
        {
          withCredentials: true,
        }
      );

      if (response.data.length === 0) setHasMore(false);

      setSelectedChatMessages(response.data, false);

      if (pageNumber === 1) {
        isInitialLoad.current = true;
      }

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

      setSelectedChatMessages(response.data, false);

      if (pageNumber === 1) {
        isInitialLoad.current = true;
      }

      setPage(pageNumber);
    } catch (error) {
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedChatData?._id) {
      if (selectedChatType === "contact") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getMessages(1);
      }
      if (selectedChatType === "channel") {
        setPage(1);
        setHasMore(true);
        setSelectedChatMessages([], true);
        getChannelMessages(1);
      }
    }
  }, [selectedChatData, selectedChatType, setSelectedChatMessages]);

  const messagesRef = useRef(new Map());

  const checkIfImage = (filePath) => {
    const imageRegex =
      /\.(jpg|jpeg|png|gif|bmp|tiff|tif|webp|svg|ico|heic|heif)$/i;
    return imageRegex.test(filePath);
  };

  const downloadFile = async (url) => {
    try {
      setIsDownloading(true);
      setFileDownloadingProgress(0);
      const response = await axios.get(`${url}`, {
        responseType: "blob",
        onDownloadProgress: (data) =>
          setFileDownloadingProgress(
            Math.round((100 * data.loaded) / (data.total || 1))
          ),
      });

      setIsDownloading(false);

      const urlBlob = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = urlBlob;
      link.setAttribute("download", url.split("/").pop() || "file");

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(urlBlob);
    } catch (error) {
      console.log("Error downloading file: ", error);
      setIsDownloading(false);
    }
  };

  // Message status indicator component - bright sky-blue for read visibility
  const MessageStatus = ({ status, isSent }) => (
    <span className="inline-flex items-center ml-1.5">
      {status === "sent" && (
        <MdDone className="w-4 h-4 text-white/70" />
      )}
      {status === "delivered" && (
        <IoMdDoneAll className="w-4 h-4 text-white/70" />
      )}
      {status === "read" && (
        <IoMdDoneAll className="w-4 h-4 text-sky-300" />
      )}
    </span>
  );

  const renderDMMessages = (message, index) => {
    const isSent = message.sender === user.id;
    const fileName = message.fileUrl?.split("/").pop() || "";
    const isImage = message.messageType === "file" && checkIfImage(fileName);

    return (
      <div
        className={cn(
          "flex w-full animate-message-in",
          isSent ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "message-bubble",
            isSent ? "message-bubble-sent" : "message-bubble-received"
          )}
        >
          {/* Text Message */}
          {message.messageType === "text" && (
            <div className="flex flex-col">
              <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                {message.content}
              </p>
              <div className="flex items-center justify-end gap-1 mt-1 -mb-1">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
                {isSent && <MessageStatus status={message.status} isSent={isSent} />}
              </div>
            </div>
          )}

          {/* File Message */}
          {message.messageType === "file" && (
            <div className="flex flex-col">
              {isImage ? (
                <div
                  className="cursor-pointer overflow-hidden rounded-xl"
                  onClick={() => {
                    setShowImage(true);
                    setImageURL(message.fileUrl);
                  }}
                >
                  <img
                    src={message.fileUrl}
                    alt="Shared image"
                    className="max-w-[240px] sm:max-w-[280px] h-auto object-cover transition-transform duration-200 hover:scale-105"
                  />
                </div>
              ) : (
                <div className={cn(
                  "flex items-center gap-3 p-3 rounded-xl",
                  isSent ? "bg-primary-hover" : "bg-background-tertiary"
                )}>
                  <div className={cn(
                    "flex items-center justify-center w-10 h-10 rounded-lg",
                    isSent ? "bg-primary-foreground/20" : "bg-primary/20"
                  )}>
                    <MdFolderZip className={cn(
                      "w-5 h-5",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </div>
                  <span className={cn(
                    "text-sm truncate max-w-[150px] sm:max-w-[200px]",
                    isSent ? "text-primary-foreground" : "text-foreground"
                  )}>
                    {fileName}
                  </span>
                  <button
                    onClick={() => downloadFile(message.fileUrl)}
                    className={cn(
                      "touch-target rounded-full transition-colors",
                      isSent 
                        ? "hover:bg-primary-foreground/20" 
                        : "hover:bg-accent"
                    )}
                  >
                    <IoArrowDownCircle className={cn(
                      "w-6 h-6",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </button>
                </div>
              )}
              <div className="flex items-center justify-end gap-1 mt-1.5">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
                {isSent && <MessageStatus status={message.status} isSent={isSent} />}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderChannelMessage = (message, index) => {
    const isSent = message.sender?._id === user.id;
    const fileName = message.fileUrl?.split("/").pop() || "";
    const isImage = message.messageType === "file" && checkIfImage(fileName);

    return (
      <div
        className={cn(
          "flex w-full animate-message-in",
          isSent ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "message-bubble",
            isSent ? "message-bubble-sent" : "message-bubble-received"
          )}
        >
          {/* Sender name for channel messages (received only) */}
          {!isSent && message.sender && (
            <p className="text-xs font-medium text-primary mb-1">
              {message.sender?.firstName} {message.sender?.lastName}
            </p>
          )}

          {/* Text Message */}
          {message.messageType === "text" && (
            <div className="flex flex-col">
              <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                {message.content}
              </p>
              <div className="flex items-center justify-end gap-1 mt-1 -mb-1">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
              </div>
            </div>
          )}

          {/* File Message */}
          {message.messageType === "file" && (
            <div className="flex flex-col">
              {isImage ? (
                <div
                  className="cursor-pointer overflow-hidden rounded-xl"
                  onClick={() => {
                    setShowImage(true);
                    setImageURL(message.fileUrl);
                  }}
                >
                  <img
                    src={message.fileUrl}
                    alt="Shared image"
                    className="max-w-[240px] sm:max-w-[280px] h-auto object-cover transition-transform duration-200 hover:scale-105"
                  />
                </div>
              ) : (
                <div className={cn(
                  "flex items-center gap-3 p-3 rounded-xl",
                  isSent ? "bg-primary-hover" : "bg-background-tertiary"
                )}>
                  <div className={cn(
                    "flex items-center justify-center w-10 h-10 rounded-lg",
                    isSent ? "bg-primary-foreground/20" : "bg-primary/20"
                  )}>
                    <MdFolderZip className={cn(
                      "w-5 h-5",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </div>
                  <span className={cn(
                    "text-sm truncate max-w-[150px] sm:max-w-[200px]",
                    isSent ? "text-primary-foreground" : "text-foreground"
                  )}>
                    {fileName}
                  </span>
                  <button
                    onClick={() => downloadFile(message.fileUrl)}
                    className={cn(
                      "touch-target rounded-full transition-colors",
                      isSent 
                        ? "hover:bg-primary-foreground/20" 
                        : "hover:bg-accent"
                    )}
                  >
                    <IoArrowDownCircle className={cn(
                      "w-6 h-6",
                      isSent ? "text-primary-foreground" : "text-primary"
                    )} />
                  </button>
                </div>
              )}
              <div className="flex items-center justify-end gap-1 mt-1.5">
                <span className={cn(
                  "text-[10px]",
                  isSent ? "text-primary-foreground/70" : "text-foreground-muted"
                )}>
                  {moment(message.createdAt).format("LT")}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

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
        <div key={message._id} className="flex flex-col gap-2">
          {showDate && (
            <div className="flex justify-center my-4">
              <span className="date-separator">
                {moment(message.createdAt).format("LL")}
              </span>
            </div>
          )}
          {selectedChatType === "contact" && renderDMMessages(message, index)}
          {selectedChatType === "channel" && renderChannelMessage(message, index)}
        </div>
      );
    });
  };

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const { scrollTop, scrollHeight, clientHeight } = container;
    
    // Show scroll button when scrolled up more than 300px from bottom
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setShowScrollButton(distanceFromBottom > 300);

    // Load more messages when near top
    if (!loading && hasMore && scrollTop < 50) {
      const scrollYBeforeFetch = scrollHeight;

      if (selectedChatType === "contact") {
        getMessages(page + 1).then(() => {
          requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight - scrollYBeforeFetch;
            }
          });
        });
      } else if (selectedChatType === "channel") {
        getChannelMessages(page + 1).then(() => {
          requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight - scrollYBeforeFetch;
            }
          });
        });
      }
    }
  }, [loading, hasMore, selectedChatType, page]);

  // Scroll to bottom on initial load and new messages
  useEffect(() => {
    if (!containerRef.current || selectedChatMessages.length === 0) return;

    const container = containerRef.current;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 400;

    // Initial load - instant scroll to bottom
    if (isInitialLoad.current) {
      requestAnimationFrame(() => {
        scrollToBottom(false); // Instant scroll on initial load
        // After a tiny delay, enable smooth scrolling for subsequent messages
        setTimeout(() => {
          isInitialLoad.current = false;
        }, 100);
      });
    } else if (isNearBottom) {
      // New message received while near bottom - smooth scroll
      scrollToBottom(true);
    }
  }, [selectedChatMessages, scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll, { passive: true });
    }
    return () => {
      if (container) {
        container.removeEventListener("scroll", handleScroll);
      }
    };
  }, [handleScroll]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden bg-background px-3 py-4 sm:px-4 md:px-6"
    >
      {/* Loading indicator */}
      {loading && (
        <div className="flex justify-center py-4">
          <div className="flex gap-1">
            <div className="typing-dot" />
            <div className="typing-dot" />
            <div className="typing-dot" />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex flex-col gap-1">
        {renderMessages()}
      </div>

      {/* Scroll anchor */}
      <div ref={newMessageRef} />

      {/* Scroll to bottom button */}
      <button
        onClick={() => scrollToBottom(true)}
        className={cn(
          "fixed bottom-24 right-4 sm:right-8 z-40 w-10 h-10 rounded-full bg-background-secondary border border-border-subtle shadow-lg flex items-center justify-center transition-all duration-300 hover:bg-accent hover:scale-110 active:scale-95",
          showScrollButton 
            ? "opacity-100 translate-y-0" 
            : "opacity-0 translate-y-4 pointer-events-none"
        )}
        aria-label="Scroll to bottom"
      >
        <ChevronDown className="w-5 h-5 text-foreground" />
      </button>

      {/* Image Preview Modal */}
      {showImage && imageURL && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm animate-fade-in">
          <div className="relative max-w-[90vw] max-h-[85vh]">
            <img
              src={imageURL}
              alt="Preview"
              className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-chat-lg"
            />
          </div>

          {/* Modal Actions */}
          <div className="fixed top-4 right-4 flex items-center gap-2">
            <button
              onClick={() => downloadFile(imageURL)}
              className="touch-target rounded-full bg-background-secondary hover:bg-accent transition-colors"
            >
              <IoArrowDownCircle className="w-7 h-7 text-foreground" />
            </button>

            <button
              onClick={() => {
                setImageURL(null);
                setShowImage(false);
              }}
              className="touch-target rounded-full bg-background-secondary hover:bg-destructive/20 transition-colors"
            >
              <IoCloseSharp className="w-7 h-7 text-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageContainer;
