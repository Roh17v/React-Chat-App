import { useState, useEffect } from "react";
import { Phone, PhoneOff, Video } from "lucide-react"; 
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

const IncomingCallOverlay = () => {
  const { incomingCall, clearIncomingCall, setActiveCall } = useAppStore();
  const { socket } = useSocket();
  const [pulse, setPulse] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => setPulse((p) => !p), 1500);
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

  return (
    <div className="fixed inset-0 bg-gradient-to-br from-black/90 via-black/80 to-black/90 backdrop-blur-md flex items-center justify-center z-50 animate-in fade-in duration-300">
      
      {/* Background Pulse Animation */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-gradient-to-r ${isVideoCall ? "from-blue-500/20 to-purple-500/20" : "from-green-500/20 to-emerald-500/20"} rounded-full blur-3xl transition-all duration-1000 ${pulse ? "scale-100 opacity-60" : "scale-110 opacity-40"}`} />
      </div>

      <div className="relative bg-gradient-to-b from-slate-800/90 to-slate-900/90 backdrop-blur-xl p-8 rounded-3xl border border-white/10 shadow-2xl w-[90%] max-w-md">
        
        {/* Color Line at top */}
        <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-24 h-1 rounded-b-full bg-gradient-to-r ${isVideoCall ? "from-blue-500 to-purple-500" : "from-green-500 to-emerald-500"}`} />

        {/* CALLER AVATAR */}
        <div className="flex justify-center mb-6">
          <div className="relative">
            {/* Ping Animation Ring */}
            <div className={`absolute inset-0 rounded-full bg-gradient-to-r ${isVideoCall ? "from-blue-500 to-purple-500" : "from-green-500 to-emerald-500"} opacity-20 animate-ping`} />

            {/* Avatar Container */}
            <Avatar className="h-24 w-24 border-4 border-slate-800 shadow-2xl">
              {incomingCall.callerImage ? (
                <AvatarImage 
                  src={incomingCall.callerImage} 
                  alt={callerName} 
                  className="object-cover" 
                />
              ) : (
                <AvatarFallback className={`text-3xl font-bold text-white ${isVideoCall ? "bg-blue-600" : "bg-green-600"}`}>
                  {callerInitial}
                </AvatarFallback>
              )}
            </Avatar>

            {/* Type Icon Badge (Video/Phone icon) */}
            <div className={`absolute -bottom-2 -right-2 p-2 rounded-full border-2 border-slate-900 ${isVideoCall ? "bg-blue-600" : "bg-green-600"}`}>
              {isVideoCall ? <Video className="w-4 h-4 text-white" /> : <Phone className="w-4 h-4 text-white" />}
            </div>
          </div>
        </div>

        {/* Caller Info Text */}
        <div className="text-center mb-8">
          <p className="text-sm text-slate-400 uppercase tracking-wider mb-2 font-medium">
            Incoming {incomingCall.callType} call
          </p>
          <h3 className="text-2xl font-bold text-white mb-1">
            {callerName}
          </h3>
          <p className="text-slate-400 text-sm">
            {incomingCall.callerEmail || ""}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-center items-center gap-8">
          {/* Decline */}
          <button
            onClick={() => {
              socket.emit("call:reject", { callId: incomingCall.callId });
              clearIncomingCall();
            }}
            className="group relative flex flex-col items-center gap-2"
          >
            <div className="relative w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center border border-red-500/20 group-hover:bg-red-500 transition-all duration-300">
              <PhoneOff className="w-7 h-7 text-red-500 group-hover:text-white transition-colors" />
            </div>
            <p className="text-xs text-slate-400 font-medium">Decline</p>
          </button>

          {/* Accept */}
          <button
            onClick={() => {
              socket.emit("call:accept", { callId: incomingCall.callId });
              setActiveCall({
                ...incomingCall,
                otherUserId: incomingCall.callerId,
                otherUserName: callerName,
                otherUserImage: incomingCall.callerImage,
                isCaller: false,
              });
              clearIncomingCall();
            }}
            className="group relative flex flex-col items-center gap-2"
          >
            <div className="relative w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center border border-green-500/20 group-hover:bg-green-500 transition-all duration-300">
              <Phone className="w-7 h-7 text-green-500 group-hover:text-white transition-colors animate-bounce" />
            </div>
            <p className="text-xs text-slate-400 font-medium">Accept</p>
          </button>
        </div>
      </div>
    </div>
  );
};

export default IncomingCallOverlay;