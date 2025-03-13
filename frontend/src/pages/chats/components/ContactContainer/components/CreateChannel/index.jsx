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

import axios, { all } from "axios";
import {
  CREATE_NEW_CHANNEL_ROUTE,
  GET_ALL_CONTACTS_ROUTE,
  USER_ROUTES,
} from "@/utils/constants";

import useAppStore from "@/store";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import MultipleSelector from "@/components/ui/multiselect";
import { toast } from "sonner";

const CreateChannel = () => {
  const { addChannel, channels } =
    useAppStore();
  const [newChannelModal, setNewChannelModal] = useState(false);
  const [allContacts, setAllContacts] = useState([]);
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [channelName, setChannelName] = useState("");

  useEffect(() => {
    const getData = async () => {
      try {
        const response = await axios.get(GET_ALL_CONTACTS_ROUTE, {
          withCredentials: true,
        });

        setAllContacts(response.data.contacts);
      } catch (error) {
        console.log(error);
      }
    };

    getData();
  }, []);

  const createChannel = async () => {
    if (!channelName) return toast.error("Enter a Channel Name.");
    if (selectedContacts.length <= 0)
      return toast.error("Select Contacts to Create Channel");

    console.log(selectedContacts);
    try {
      const response = await axios.post(
        CREATE_NEW_CHANNEL_ROUTE,
        {
          channelName: channelName,
          members: selectedContacts.map((contact) => contact.value),
        },
        {
          withCredentials: true,
        }
      );

      if (response.status === 201) {
        setChannelName("");
        setSelectedContacts([]);
        setNewChannelModal(false);
        addChannel(response.data.channel);
        console.log(channels);
      }
    } catch (error) {
      console.log(error);
    }
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <FaPlus
              className="text-neutral-400 font-light text-opacity-90 text-start hover:text-neutral-100 cursor-pointer duration-300 transition-all"
              onClick={() => setNewChannelModal(true)}
            />
          </TooltipTrigger>
          <TooltipContent className="bg-[#1c1b1e] border-none mb-2 p-3 text-white">
            Create a Channel
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog
        open={newChannelModal}
        onOpenChange={(open) => {
          setNewChannelModal(open);
          if (!open) setSearchedContacts([]);
          setSearchTerm("");
        }}
      >
        <DialogContent className="bg-[#181920] border-none w-[400px] h-[400px] text-white flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center">
              Please Select Contacts
            </DialogTitle>
          </DialogHeader>
          <div>
            <Input
              placeholder="Channel Name"
              className="rounded-lg p-6 bg-[#2c2a3b] border-none"
              onChange={(e) => {
                setChannelName(e.target.value);
              }}
              value={channelName}
            />
          </div>
          <div>
            <MultipleSelector
              defaultOptions={allContacts}
              placeholder="Search Contacts"
              value={selectedContacts}
              onChange={setSelectedContacts}
              emptyIndicator={
                <p className="text-center text-lg leading-10 text-white bg-[#2c2e3b] h-full">
                  No results found.
                </p>
              }
              className="rounded-lg bg-[#2c2e3b] border-none py-2 text-white"
            />
          </div>
          <div>
            <Button
              className="w-full text-md py-6 bg-purple-700 hover:bg-purple-900 transition-all duration-300"
              onClick={createChannel}
            >
              Create Channel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateChannel;
