import { useState, useEffect } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
const IncomingCallOverlay = () => {
  const { incomingCall, clearIncomingCall, setActiveCall } = useAppStore();
  const { socket } = useSocket();
  const [isRinging, setIsRinging] = useState(true);
  useEffect(() => {
    const interval = setInterval(() => setIsRinging((p) => !p), 1000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!socket) return;
    const handleCallEnd = () => clearIncomingCall();
    socket.on("call:end", handleCallEnd);
    return () => socket.off("call:end", handleCallEnd);
  }, [socket, clearIncomingCall]);
  if (!incomingCall) return null;
  const isVideoCall = incomingCall.callType === "video";
  const callerName = incomingCall.callerName || "Unknown User";
  const callerInitial = callerName.charAt(0).toUpperCase();
  const handleDecline = () => {
    socket.emit("call:reject", { callId: incomingCall.callId });
    clearIncomingCall();
  };
  const handleAccept = () => {
    socket.emit("call:accept", { callId: incomingCall.callId });
    setActiveCall({
      ...incomingCall,
      otherUserId: incomingCall.callerId,
      otherUserName: callerName,
      otherUserImage: incomingCall.callerImage,
      isCaller: false,
    });
    clearIncomingCall();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop with blur */}
      <div className="absolute inset-0 bg-background/90 backdrop-blur-xl" />
      {/* Animated background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full transition-all duration-1000 ${
            isRinging ? "bg-primary/20 scale-100" : "bg-primary/10 scale-110"
          } blur-3xl`}
        />
      </div>
      {/* Content Card */}
      <div className="relative z-10 w-full max-w-sm mx-4 animate-scale-in">
        <div className="bg-background-secondary/95 backdrop-blur-xl border border-border rounded-3xl overflow-hidden shadow-chat-lg">
          {/* Top accent line */}
          <div className="h-1 bg-gradient-to-r from-primary via-primary to-transparent" />
          <div className="p-8">
            {/* Avatar Section */}
            <div className="flex flex-col items-center mb-8">
              {/* Avatar with ring animation */}
              <div className="relative">
                {/* Ping rings */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-28 h-28 rounded-full border-2 border-primary/30 animate-ping" />
                </div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div
                    className="w-32 h-32 rounded-full border border-primary/20 animate-ping"
                    style={{ animationDelay: "0.5s" }}
                  />
                </div>
                {/* Avatar */}
                <Avatar className="w-24 h-24 border-4 border-primary/30 shadow-chat-glow">
                  {incomingCall.callerImage ? (
                    <AvatarImage
                      src={incomingCall.callerImage}
                      alt={callerName}
                      className="object-cover"
                    />
                  ) : (
                    <AvatarFallback className="bg-gradient-to-br from-primary to-primary-hover text-primary-foreground text-3xl font-bold">
                      {callerInitial}
                    </AvatarFallback>
                  )}
                </Avatar>
                {/* Call type badge */}
                <div className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-primary flex items-center justify-center shadow-lg border-4 border-background-secondary">
                  {isVideoCall ? (
                    <Video className="w-5 h-5 text-primary-foreground" />
                  ) : (
                    <Phone className="w-5 h-5 text-primary-foreground" />
                  )}
                </div>
              </div>
            </div>
            {/* Caller Info */}
            <div className="text-center space-y-2 mb-10">
              <p className="text-foreground-muted text-sm uppercase tracking-wider font-medium">
                Incoming {incomingCall.callType} call
              </p>
              <h2 className="text-2xl font-bold text-foreground">
                {callerName}
              </h2>
              {incomingCall.callerEmail && (
                <p className="text-foreground-secondary text-sm">
                  {incomingCall.callerEmail}
                </p>
              )}
            </div>
            {/* Action Buttons */}
            <div className="flex items-center justify-center gap-12">
              {/* Decline Button */}
              <button
                onClick={handleDecline}
                className="group flex flex-col items-center gap-3"
              >
                <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center transition-all duration-200 group-hover:bg-destructive group-hover:scale-110 group-active:scale-95">
                  <PhoneOff className="w-7 h-7 text-destructive group-hover:text-destructive-foreground transition-colors" />
                </div>
                <span className="text-sm font-medium text-foreground-secondary group-hover:text-foreground transition-colors">
                  Decline
                </span>
              </button>
              {/* Accept Button */}
              <button
                onClick={handleAccept}
                className="group flex flex-col items-center gap-3"
              >
                <div className="relative">
                  {/* Glow ring */}
                  <div className="absolute inset-0 rounded-full bg-primary/40 blur-md scale-110 group-hover:scale-125 transition-transform duration-300" />
                  <div className="relative w-16 h-16 rounded-full bg-primary flex items-center justify-center transition-all duration-200 group-hover:scale-110 group-active:scale-95 shadow-lg shadow-primary/30">
                    <Phone className="w-7 h-7 text-primary-foreground transition-colors" />
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground-secondary group-hover:text-foreground transition-colors">
                  Accept
                </span>
              </button>
            </div>
          </div>
          {/* Bottom hint */}
          <div className="px-8 pb-6">
            <p className="text-center text-xs text-foreground-muted">
              Swipe up to answer with video
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
export default IncomingCallOverlay;
