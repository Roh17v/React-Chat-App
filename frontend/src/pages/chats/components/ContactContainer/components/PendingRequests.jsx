import React, { useState, useEffect } from "react";
import axios from "axios";
import { HOST } from "@/utils/constants";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useSocket } from "@/context/SocketContext";

const PendingRequests = () => {
  const [requests, setRequests] = useState([]);
  const { socket } = useSocket();

  const fetchRequests = async () => {
    try {
      const response = await axios.get(`${HOST}/api/connections/pending`, {
        withCredentials: true,
      });
      setRequests(response.data);
    } catch (error) {
      console.log(error);
    }
  };

  useEffect(() => {
    fetchRequests();

    // Listen for real-time incoming requests
    if (socket) {
      socket.on("connection-request-received", () => {
        fetchRequests();
      });
    }

    return () => {
      if (socket) {
        socket.off("connection-request-received");
      }
    };
  }, [socket]);

  const handleRespond = async (requestId, status, requesterId) => {
    try {
      const response = await axios.put(
        `${HOST}/api/connections/respond`,
        { requestId, status },
        { withCredentials: true }
      );
      if (response.status === 200) {
        toast.success(`Request ${status}!`);
        fetchRequests(); // Refresh the list after action
        
        if (socket && status === "accepted") {
          socket.emit("connection-request-accepted", {
            requesterId,
            connectionData: { requestId, status: "accepted" }
          });
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to respond");
    }
  };

  // If there are no pending requests, don't show the section at all
  if (requests.length === 0) return null;

  return (
    <div className="py-3">
      <div className="flex items-center justify-between px-4 mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
          Pending Requests ({requests.length})
        </h2>
      </div>
      <div className="px-2 space-y-1">
        {requests.map((request) => {
          const requester = request.requester_id;
          return (
            <div
              key={request._id}
              className="flex items-center justify-between p-2 rounded-xl hover:bg-background-tertiary transition-colors"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Avatar className="h-10 w-10 ring-2 ring-border">
                  {requester.image ? (
                    <AvatarImage
                      src={requester.image}
                      alt="avatar"
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold text-sm">
                      {requester.firstName
                        ? requester.firstName.charAt(0).toUpperCase()
                        : requester.email.charAt(0).toUpperCase()}
                    </div>
                  )}
                </Avatar>
                
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-foreground font-medium text-sm truncate">
                    {requester.firstName && requester.lastName
                      ? `${requester.firstName} ${requester.lastName}`
                      : requester.email}
                  </p>
                  <p className="text-foreground-muted text-xs truncate">
                    {requester.username ? `@${requester.username}` : requester.email}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 ml-2">
                <Button
                  size="sm"
                  className="h-7 text-xs bg-primary hover:bg-primary-hover text-white rounded-lg px-3"
                  onClick={() => handleRespond(request._id, "accepted", requester._id)}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-foreground-secondary hover:text-destructive hover:bg-destructive/10 rounded-lg px-3"
                  onClick={() => handleRespond(request._id, "rejected", requester._id)}
                >
                  Decline
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PendingRequests;
