import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { UPLOAD_FILE_ROUTE } from "@/utils/constants";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { IoSend } from "react-icons/io5";
import { Check, Hash, Users } from "lucide-react";

export default function ShareModal() {
  const {
    user,
    pendingShareData,
    setPendingShareData,
    directMessagesContacts,
    channels,
    setIsUploading,
    setFileUploadingProgress,
  } = useAppStore();
  const { socket } = useSocket();
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [selectedChannels, setSelectedChannels] = useState([]);
  const [isSending, setIsSending] = useState(false);

  if (!pendingShareData) return null;

  const handleClose = () => {
    if (!isSending) {
      setPendingShareData(null);
      setSelectedContacts([]);
      setSelectedChannels([]);
    }
  };

  const toggleContact = (contactId) => {
    setSelectedContacts((prev) =>
      prev.includes(contactId)
        ? prev.filter((id) => id !== contactId)
        : [...prev, contactId]
    );
  };

  const toggleChannel = (channelId) => {
    setSelectedChannels((prev) =>
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId]
    );
  };

  const handleSend = async () => {
    if (selectedContacts.length === 0 && selectedChannels.length === 0) {
      toast.error("Please select at least one contact or channel");
      return;
    }

    setIsSending(true);
    let fileUrl = null;
    let fileName = null;
    let fileMetadata = {};

    if (pendingShareData.fileUrl) {
      try {
        setIsUploading(true);
        setFileUploadingProgress(0);
        const src = Capacitor.convertFileSrc(pendingShareData.fileUrl);
        const res = await fetch(src);
        const blob = await res.blob();

        const mimeType =
          pendingShareData.fileMimeType || blob.type || "application/octet-stream";
        let originalName = pendingShareData.fileName || "shared_file";

        const hasExtension = /\.[a-zA-Z0-9]+$/.test(originalName);
        if (!hasExtension && mimeType.includes("/")) {
          const ext = mimeType.split("/")[1];
          if (ext && ext !== "octet-stream" && ext !== "*") {
            originalName += `.${ext}`;
          }
        }

        const file = new File([blob], originalName, { type: mimeType });

        if (file.type.startsWith('image/')) {
          fileMetadata = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              resolve({ width: img.width, height: img.height });
              URL.revokeObjectURL(img.src);
            };
            img.onerror = () => resolve({});
            img.src = URL.createObjectURL(file);
          });
        }

        const formData = new FormData();
        formData.append("file", file);

        const response = await axios.post(UPLOAD_FILE_ROUTE, formData, {
          withCredentials: true,
          onUploadProgress: (data) =>
            setFileUploadingProgress(Math.round((100 * data.loaded) / data.total)),
        });

        if (response.status === 201 && response.data) {
          fileUrl = response.data.fileUrl;
          fileName = file.name;
        }
        setIsUploading(false);
      } catch (e) {
        console.error("Failed to upload shared file", e);
        setIsUploading(false);
        toast.error("Failed to upload shared file");
        setIsSending(false);
        return;
      }
    }

    const messageContent = pendingShareData.text || undefined;
    const messageType = fileUrl ? "file" : "text";

    for (const receiverId of selectedContacts) {
      socket.emit("sendMessage", {
        sender: user.id,
        content: messageContent,
        receiver: receiverId,
        messageType,
        fileUrl,
        fileName,
        fileMetadata,
      });
    }
    
    for (const channelId of selectedChannels) {
      socket.emit("send-channel-message", {
        sender: user.id,
        content: messageContent,
        messageType,
        fileUrl,
        fileName,
        fileMetadata,
        channelId,
      });
    }

    toast.success("Shared successfully!");
    setIsSending(false);
    setPendingShareData(null);
    setSelectedContacts([]);
    setSelectedChannels([]);
  };

  const totalSelected = selectedContacts.length + selectedChannels.length;

  return (
    <Dialog open={!!pendingShareData} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-md p-0 gap-0 bg-background-secondary border-border-subtle rounded-2xl overflow-hidden shadow-chat-lg">
        <DialogHeader className="px-5 py-4 border-b border-border-subtle">
          <DialogTitle className="text-foreground text-lg font-semibold">
            Send to...
          </DialogTitle>
          {totalSelected > 0 && (
            <p className="text-xs text-foreground-muted mt-1">
              {totalSelected} selected
            </p>
          )}
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] min-h-[280px]">
          <div className="px-2 py-2 space-y-1">
            {directMessagesContacts?.length > 0 && (
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <Users className="w-3.5 h-3.5 text-foreground-muted" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                  Chats
                </h3>
              </div>
            )}
            {directMessagesContacts?.map((contact) => {
              const isSelected = selectedContacts.includes(contact._id);
              return (
                <div
                  key={contact._id}
                  onClick={() => toggleContact(contact._id)}
                  className={`contact-item ${isSelected ? "bg-accent" : ""}`}
                >
                  <div className="relative shrink-0">
                    <Avatar className="h-11 w-11">
                      {contact.image ? (
                        <AvatarImage src={contact.image} alt={contact.firstName} />
                      ) : null}
                      <AvatarFallback className="bg-primary/15 text-primary font-semibold">
                        {contact.firstName
                          ? contact.firstName[0].toUpperCase()
                          : contact.email[0].toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {contact.firstName
                        ? `${contact.firstName} ${contact.lastName ?? ""}`.trim()
                        : contact.email}
                    </p>
                  </div>

                  <div
                    className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      isSelected
                        ? "bg-primary text-primary-foreground scale-100"
                        : "border-2 border-border scale-90"
                    }`}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                  </div>
                </div>
              );
            })}

            {channels?.length > 0 && (
              <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                <Hash className="w-3.5 h-3.5 text-foreground-muted" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                  Channels
                </h3>
              </div>
            )}
            {channels?.map((channel) => {
              const isSelected = selectedChannels.includes(channel._id);
              return (
                <div
                  key={channel._id}
                  onClick={() => toggleChannel(channel._id)}
                  className={`contact-item ${isSelected ? "bg-accent" : ""}`}
                >
                  <div className="h-11 w-11 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold shrink-0">
                    {channel.channelName ? channel.channelName[0].toUpperCase() : "#"}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {channel.channelName || "Channel"}
                    </p>
                  </div>

                  <div
                    className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      isSelected
                        ? "bg-primary text-primary-foreground scale-100"
                        : "border-2 border-border scale-90"
                    }`}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                  </div>
                </div>
              );
            })}

            {(!directMessagesContacts || directMessagesContacts.length === 0) &&
              (!channels || channels.length === 0) && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-sm text-foreground-muted">
                    No chats or channels available
                  </p>
                </div>
              )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-4 py-3 border-t border-border-subtle bg-background-tertiary/50">
          <Button
            onClick={handleSend}
            disabled={isSending || totalSelected === 0}
            className="w-full h-11 rounded-xl bg-primary hover:bg-primary-hover text-primary-foreground font-semibold gap-2 shadow-chat-glow transition-all disabled:opacity-50"
          >
            {isSending ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Sending...
              </span>
            ) : (
              <>
                <IoSend className="w-4 h-4" />
                Send {totalSelected > 0 && `(${totalSelected})`}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
