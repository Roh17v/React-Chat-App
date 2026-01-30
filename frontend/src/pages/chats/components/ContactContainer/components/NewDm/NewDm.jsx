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
import Lottie from "react-lottie";
import { animationDefaultOptions } from "@/lib/utils";
import axios from "axios";
import { USER_ROUTES, HOST } from "@/utils/constants";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";

const NewDm = () => {
  const { setSelectedChatType, setSelectedChatData } = useAppStore();
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
              Search for a contact to start a conversation
            </DialogDescription>
          </DialogHeader>

          <Input
            placeholder="Search by name or email..."
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
                  <button
                    key={contact._id}
                    onClick={() => selectNewContact(contact)}
                    className="w-full contact-item"
                  >
                    <div className="relative">
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
                    </div>

                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-foreground font-medium text-sm truncate">
                        {contact.firstName && contact.lastName
                          ? `${contact.firstName} ${contact.lastName}`
                          : contact.email}
                      </p>
                      <p className="text-foreground-muted text-xs truncate">
                        {contact.email}
                      </p>
                    </div>
                  </button>
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