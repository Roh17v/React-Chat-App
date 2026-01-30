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
  DialogDescription,
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
          <TooltipTrigger asChild>
            <button
              onClick={() => setNewChannelModal(true)}
              className="touch-target flex items-center justify-center rounded-full text-foreground-secondary hover:text-primary hover:bg-accent transition-all duration-200 active:scale-95"
            >
              <FaPlus className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="bg-popover text-popover-foreground border-border">
            Create Channel
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
        <DialogContent className="bg-background-secondary border-border text-foreground w-[90vw] max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg font-semibold">
              Create Channel
            </DialogTitle>
            <DialogDescription className="text-foreground-muted text-sm">
              Create a group channel with your contacts
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div>
              <label className="text-foreground-secondary text-xs font-medium uppercase tracking-wider mb-2 block">
                Channel Name
              </label>
              <Input
                placeholder="Enter channel name..."
                className="bg-background-tertiary border-border text-foreground placeholder:text-foreground-muted focus:ring-primary rounded-xl h-11"
                onChange={(e) => setChannelName(e.target.value)}
                value={channelName}
              />
            </div>

            <div>
              <label className="text-foreground-secondary text-xs font-medium uppercase tracking-wider mb-2 block">
                Add Members
              </label>
              <MultipleSelector
                value={selectedContacts}
                onChange={setSelectedContacts}
                defaultOptions={allContacts}
                placeholder="Select contacts..."
                emptyIndicator={
                  <p className="text-center text-foreground-muted py-4 text-sm">
                    No contacts found
                  </p>
                }
                className="rounded-xl bg-background-tertiary border-border text-foreground"
              />
            </div>

            <Button
              onClick={createChannel}
              className="w-full h-11 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-xl transition-all duration-200 active:scale-[0.98]"
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