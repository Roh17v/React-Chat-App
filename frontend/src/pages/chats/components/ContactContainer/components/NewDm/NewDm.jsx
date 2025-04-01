import React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FaPlus } from "react-icons/fa6";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import Lottie from "react-lottie";
import { animationDefaultOptions } from "@/lib/utils";
import axios from "axios";
import { USER_ROUTES } from "@/utils/constants";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { HOST } from "@/utils/constants";
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
          <TooltipTrigger>
            <FaPlus
              className="text-neutral-400 font-light text-opacity-90 text-start hover:text-neutral-100 cursor-pointer duration-300 transition-all"
              onClick={() => setOpenNewContactModel(true)}
            />
          </TooltipTrigger>
          <TooltipContent className="bg-[#1c1b1e] border-none mb-2 p-3 text-white">
            Select New Contact
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
        <DialogContent className="bg-[#181920] border-none w-[400px] h-[400px] text-white flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center">
              Please Select a Contact
            </DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Search Contacts"
            className="rounded-lg p-6 bg-[#2c2a3b] border-none"
            onChange={(e) => {
              setSearchTerm(e.target.value);
              handleSearch(e.target.value);
            }}
          />
          <ScrollArea className="h-[250px] flex flex-col gap-3 overflow-y-auto">
            {searchedContacts.length > 0 ? (
              searchedContacts.map((contact, index) => (
                <div
                  key={contact.id || index}
                  onClick={() => selectNewContact(contact)}
                  className="flex gap-3 items-center cursor-pointer p-2 rounded-md hover:bg-[#3a3b42] transition"
                >
                  <Avatar
                    className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden border border-gray-500 flex items-center justify-center"
                    style={{
                      backgroundColor: `${contact.color?.bgColor || "#ccc"}80`,
                      color: `${contact.color?.textColor || "#fff"}`,
                    }}
                  >
                    {contact.image ? (
                      <AvatarImage
                        src={`${HOST}${contact.image}`}
                        alt="profile"
                        className="object-cover w-full h-full"
                      />
                    ) : (
                      <span className="uppercase text-lg sm:text-xl font-semibold">
                        {contact.firstName
                          ? contact.firstName.charAt(0)
                          : contact.email.charAt(0)}
                      </span>
                    )}
                  </Avatar>
                  <div className="flex flex-col">
                    <span className="text-white font-medium">
                      {contact.firstName && contact.lastName
                        ? `${contact.firstName} ${contact.lastName}`
                        : contact.email}
                    </span>
                    <span className="text-gray-400 text-xs">
                      {contact.email}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex-1  md:flex flex-col justify-center items-center duration-1000 transition-all mt-5 py-5">
                <Lottie
                  isClickToPauseDisabled
                  height={100}
                  width={100}
                  options={animationDefaultOptions}
                />
                <div className="pb-5 text-opacity-80 text-white flex flex-col gap-5 items-center lg:text-2xl text-xl transition-all duration-300 text-center mt-5">
                  <h3 className="poppins-medium">
                    {searchTerm ? (
                      <span>
                        No <span className="text-purple-500">Contacts</span>{" "}
                        Found!
                      </span>
                    ) : (
                      <div>
                        Hi<span className="text-purple-500">! </span>Search new
                        <span className="text-purple-500"> Contact </span>.
                      </div>
                    )}
                  </h3>
                </div>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default NewDm;
