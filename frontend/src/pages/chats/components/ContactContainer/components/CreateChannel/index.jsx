import React, { useState, useEffect } from "react";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import axios from "axios";
import {
  CREATE_NEW_CHANNEL_ROUTE,
  GET_ALL_CONTACTS_ROUTE,
} from "@/utils/constants";
import useAppStore from "@/store";
import { Button } from "@/components/ui/button";
import MultipleSelector from "@/components/ui/multiselect";
import { toast } from "sonner";

const CreateChannel = () => {
  const { addChannel, channels, directMessagesContacts } = useAppStore();
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
        console.error("Error fetching contacts:", error);
      }
    };

    getData();
  }, [directMessagesContacts, channels]);

  const createChannel = async () => {
    if (!channelName.trim()) return toast.error("Enter a valid Channel Name.");
    if (selectedContacts.length === 0)
      return toast.error("Select at least one contact.");

    try {
      const response = await axios.post(
        CREATE_NEW_CHANNEL_ROUTE,
        {
          channelName,
          members: selectedContacts.map((contact) => contact.value),
        },
        { withCredentials: true }
      );

      if (response.status === 201) {
        setChannelName("");
        setSelectedContacts([]);
        setNewChannelModal(false);
        toast.success("Channel created successfully!");
      }
    } catch (error) {
      console.error("Error creating channel:", error);
      toast.error("Failed to create channel.");
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
          if (!open) {
            setSelectedContacts([]);
            setChannelName("");
          }
        }}
      >
        <DialogContent className="bg-[#181920] border-none w-[400px] h-[400px] text-white flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center">
              Create a New Channel
            </DialogTitle>
          </DialogHeader>
          <div>
            <Input
              placeholder="Channel Name"
              className="rounded-lg p-6 bg-[#2c2a3b] border-none"
              onChange={(e) => setChannelName(e.target.value)}
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
