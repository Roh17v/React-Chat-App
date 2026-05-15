import React, { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FaPlus } from "react-icons/fa6";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import Lottie from "react-lottie";
import { animationDefaultOptions } from "@/lib/utils";
import axios from "axios";
import { USER_ROUTES, HOST } from "@/utils/constants";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import { toast } from "sonner";

const NewDm = () => {
  const { setSelectedChatType, setSelectedChatData } = useAppStore();
  const { socket } = useSocket();
  const [openNewContactModel, setOpenNewContactModel] = useState(false);
  const [searchedContacts, setSearchedContacts] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");

  const handleSearch = async (searchTerm) => {
    if (!searchTerm) {
      setSearchedContacts([]);
      return;
    }

    try {
      const response = await axios.get(
        `${HOST}${USER_ROUTES}/search?q=${searchTerm}`,
        { withCredentials: true }
      );
      setSearchedContacts(response.data);
    } catch (error) {
      console.log(error);
    }
  };

  const handleSendRequest = async (receiverId) => {
    try {
      const response = await axios.post(
        `${HOST}/api/connections/request`,
        { receiverId },
        { withCredentials: true }
      );
      if (response.status === 201) {
        toast.success("Connection request sent!");
        handleSearch(searchTerm);
        
        if (socket) {
          socket.emit("connection-request-sent", {
            receiverId,
            requestData: {
              requestId: response.data.requestId,
              status: "pending"
            }
          });
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to send request");
    }
  };

  const handleRespondRequest = async (requestId, status, requesterId) => {
    try {
      const response = await axios.put(
        `${HOST}/api/connections/respond`,
        { requestId, status },
        { withCredentials: true }
      );
      if (response.status === 200) {
        toast.success(`Request ${status}!`);
        handleSearch(searchTerm);
        
        if (socket && status === "accepted") {
          socket.emit("connection-request-accepted", {
            requesterId,
            connectionData: {
              requestId,
              status: "accepted"
            }
          });
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to respond");
    }
  };

  const selectNewContact = (contact) => {
    setOpenNewContactModel(false);
    setSelectedChatData(contact);
    setSelectedChatType("contact");
    setSearchedContacts([]);
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setOpenNewContactModel(true)}
              className="touch-target flex items-center justify-center rounded-full text-foreground-secondary hover:text-primary hover:bg-accent transition-all duration-200 active:scale-95"
            >
              <FaPlus className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="bg-popover text-popover-foreground border-border">
            New Message
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog
        open={openNewContactModel}
        onOpenChange={(open) => {
          setOpenNewContactModel(open);
          if (!open) setSearchedContacts([]);
          setSearchTerm("");
        }}
      >
        <DialogContent className="bg-background-secondary border-border text-foreground w-[90vw] max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg font-semibold">
              New Message
            </DialogTitle>
            <DialogDescription className="text-foreground-muted text-sm">
              Search by exact email or username to start a conversation
            </DialogDescription>
          </DialogHeader>

          <Input
            placeholder="Search by exact email or username..."
            className="bg-background-tertiary border-border text-foreground placeholder:text-foreground-muted focus:ring-primary rounded-xl h-11"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              handleSearch(e.target.value);
            }}
          />

          <ScrollArea className="h-[300px] mt-2">
            {searchedContacts.length > 0 ? (
              <div className="space-y-1">
                {searchedContacts.map((contact) => (
                  <div
                    key={contact._id}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-background-tertiary transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Avatar className="h-11 w-11 ring-2 ring-border">
                        {contact.image ? (
                          <AvatarImage
                            src={contact.image}
                            alt="avatar"
                            className="object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold">
                            {contact.firstName
                              ? contact.firstName.charAt(0).toUpperCase()
                              : contact.email.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </Avatar>
                      
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-foreground font-medium text-sm truncate">
                          {contact.firstName && contact.lastName
                            ? `${contact.firstName} ${contact.lastName}`
                            : contact.email}
                        </p>
                        <p className="text-foreground-muted text-xs truncate">
                          {contact.username ? `@${contact.username}` : contact.email}
                        </p>
                      </div>
                    </div>

                    {/* Action Button based on Connection Status */}
                    <div className="ml-2">
                      {(contact.connectionStatus === "none" || contact.connectionStatus === "rejected") && (
                        <Button
                          size="sm"
                          className="h-8 text-xs bg-primary hover:bg-primary-hover text-white rounded-lg"
                          onClick={() => handleSendRequest(contact._id)}
                        >
                          Connect
                        </Button>
                      )}
                      
                      {contact.connectionStatus === "pending" && contact.isRequester && (
                        <span className="text-xs text-foreground-muted px-3 py-1.5 bg-background-tertiary rounded-lg">
                          Pending
                        </span>
                      )}
                      
                      {contact.connectionStatus === "pending" && !contact.isRequester && (
                        <Button
                          size="sm"
                          className="h-8 text-xs bg-primary hover:bg-primary-hover text-white rounded-lg"
                          onClick={() => handleRespondRequest(contact.requestId, "accepted", contact._id)}
                        >
                          Accept
                        </Button>
                      )}
                      
                      {contact.connectionStatus === "accepted" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs border-primary text-primary hover:bg-primary/10 rounded-lg"
                          onClick={() => selectNewContact(contact)}
                        >
                          Message
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full py-8">
                <Lottie
                  isClickToPauseDisabled={true}
                  height={120}
                  width={120}
                  options={animationDefaultOptions}
                />
                <p className="text-foreground-muted text-sm text-center mt-4">
                  {searchTerm ? (
                    <>No contacts found for "<span className="text-foreground">{searchTerm}</span>"</>
                  ) : (
                    <>Start typing to search for contacts</>
                  )}
                </p>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default NewDm;