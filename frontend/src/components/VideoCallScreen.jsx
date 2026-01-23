import { useState, useEffect, useRef, useCallback } from "react";
import {
  IoCall,
  IoMicOff,
  IoMic,
  IoVideocamOff,
  IoVideocam,
  IoChevronDown,
  IoExpand,
  IoResize,
  IoWarning, 
  IoRefresh,
} from "react-icons/io5";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

const VideoCallScreen = () => {
  const {
    activeCall,
    clearActiveCall,
  } = useAppStore();
  const { socket } = useSocket();

  // --- UI STATE ---
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showControls, setShowControls] = useState(true);
  
  // 'ringing' = Caller waiting for answer
  // 'connected' = Media flow starting
  const [callStatus, setCallStatus] = useState(
      activeCall.isCaller ? "ringing" : "connected"
  );
  
  const [connectionStatus, setConnectionStatus] = useState("initializing");
  const [mediaError, setMediaError] = useState(null);
  
  // PiP / Drag State
  const [pipSize, setPipSize] = useState({ width: 192, height: 288 });
  const [dragPosition, setDragPosition] = useState({ x: 16, y: 16 });

  // --- WEBRTC REFS ---
  const pc = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  
  // Negotiation Flags
  const makingOffer = useRef(false);
  const ignoreOffer = useRef(false);
  const isPolite = useRef(!activeCall.isCaller); 

  // UI Refs
  const remoteVideoFullRef = useRef(null);
  const remoteVideoMiniRef = useRef(null);
  const localVideoPipRef = useRef(null);
  const localVideoMiniRef = useRef(null);
  
  // Drag Refs
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  if (!activeCall || activeCall.callType !== "video") return null;

  // --- 1. INITIALIZE MEDIA (CAMERA/MIC) ONLY ---
  // We start the camera immediately for local preview, but we DON'T connect yet.
  useEffect(() => {
    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        updateLocalVideoRefs(stream);
        setMediaError(null);
        
        // If we are the receiver (already connected), we can add tracks now
        if (!activeCall.isCaller) {
             initializePeerConnection(stream);
        }
      } catch (err) {
        console.error("Media Error:", err);
        setMediaError("Camera/Mic access denied.");
      }
    };

    startMedia();

    return () => {
      cleanup();
    };
  }, []);

  // --- 2. CALLER: WAIT FOR ACCEPTANCE ---
  useEffect(() => {
      if (!socket || !activeCall.isCaller) return;

      const handleCallAccepted = ({ callId }) => {
          setCallStatus("connected");
          // Now that receiver is ready, we initialize PC and this triggers the Offer
          if (localStreamRef.current) {
              initializePeerConnection(localStreamRef.current);
          }
      };

      socket.on("call-accepted", handleCallAccepted);
      return () => socket.off("call-accepted", handleCallAccepted);
  }, [socket, activeCall.isCaller]);


  // --- 3. PEER CONNECTION LOGIC ---
  const initializePeerConnection = (stream) => {
    if (pc.current) return; // Already initialized

    console.log("Initializing Peer Connection...");
    pc.current = new RTCPeerConnection(ICE_SERVERS);

    // A. Add Local Tracks
    stream.getTracks().forEach((track) => {
        pc.current.addTrack(track, stream);
    });

    // B. Handle Remote Tracks
    pc.current.ontrack = ({ track }) => {
      track.onunmute = () => {
        if (remoteVideoFullRef.current) remoteVideoFullRef.current.srcObject = remoteStreamRef.current;
        if (remoteVideoMiniRef.current) remoteVideoMiniRef.current.srcObject = remoteStreamRef.current;
      };
      remoteStreamRef.current.addTrack(track);
      // Force refresh
      [remoteVideoFullRef.current, remoteVideoMiniRef.current].forEach(el => {
        if (el) {
          el.srcObject = remoteStreamRef.current;
          el.play().catch(e => console.log("Autoplay error", e));
        }
      });
    };

    // C. ICE Candidates
    pc.current.onicecandidate = ({ candidate }) => {
      if (candidate && socket) {
        socket.emit("call:ice-candidate", {
          to: activeCall.otherUserId || activeCall.callerId,
          candidate,
        });
      }
    };

    // D. Connection State
    pc.current.oniceconnectionstatechange = () => {
      setConnectionStatus(pc.current.iceConnectionState);
      if (pc.current.iceConnectionState === "failed") {
        pc.current.restartIce();
      }
    };

    // E. Perfect Negotiation (Triggers Offer)
    pc.current.onnegotiationneeded = async () => {
      try {
        makingOffer.current = true;
        await pc.current.setLocalDescription();
        socket.emit("call:offer", {
          to: activeCall.otherUserId || activeCall.callerId,
          description: pc.current.localDescription,
        });
      } catch (err) {
        console.error("Negotiation error:", err);
      } finally {
        makingOffer.current = false;
      }
    };
  };


  // --- 4. SOCKET SIGNALING HANDLERS ---
  useEffect(() => {
    if (!socket) return;

    const handleDescription = async ({ description, from }) => {
      const peerConnection = pc.current;
      // If offer comes before we initialized (rare now due to gated logic), init now
      if (!peerConnection && localStreamRef.current) {
           initializePeerConnection(localStreamRef.current);
      }
      
      if (!pc.current) return;

      const offerCollision = 
        description.type === "offer" && 
        (makingOffer.current || pc.current.signalingState !== "stable");

      ignoreOffer.current = !isPolite.current && offerCollision;

      if (ignoreOffer.current) return;

      if (offerCollision) {
        await Promise.all([
          pc.current.setLocalDescription({ type: "rollback" }),
          pc.current.setRemoteDescription(description),
        ]);
      } else {
        await pc.current.setRemoteDescription(description);
      }

      if (description.type === "offer") {
        await pc.current.setLocalDescription();
        socket.emit("call:answer", {
          to: from,
          description: pc.current.localDescription,
        });
      }
    };

    const handleCandidate = async ({ candidate }) => {
       if (pc.current) {
           try {
               await pc.current.addIceCandidate(candidate);
           } catch (err) {
               if (!ignoreOffer.current) console.error("Error adding candidate", err);
           }
       }
    };

    const handleEndCall = () => cleanup();

    socket.on("call:offer", handleDescription);
    socket.on("call:answer", handleDescription);
    socket.on("call:ice-candidate", handleCandidate);
    socket.on("call:end", handleEndCall);

    return () => {
      socket.off("call:offer", handleDescription);
      socket.off("call:answer", handleDescription);
      socket.off("call:ice-candidate", handleCandidate);
      socket.off("call:end", handleEndCall);
    };
  }, [socket]);


  // --- 5. CLEANUP & HELPER ---
  const cleanup = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
    }
    if (pc.current) {
      pc.current.close();
      pc.current = null;
    }
    clearActiveCall();
    setConnectionStatus("disconnected");
  }, [clearActiveCall]);

  const endCall = () => {
    const targetId = activeCall?.otherUserId || activeCall?.callerId;
    if (targetId && socket) socket.emit("call:end", { to: targetId });
    cleanup();
  };
  
  const updateLocalVideoRefs = (stream) => {
    [localVideoPipRef.current, localVideoMiniRef.current].forEach(el => {
      if (el) {
        el.srcObject = stream;
        el.muted = true;
      }
    });
  };

  const toggleAudio = () => {
      if (localStreamRef.current) {
          const track = localStreamRef.current.getAudioTracks()[0];
          if(track) { track.enabled = !track.enabled; setIsMuted(!track.enabled); }
      }
  };
  const toggleVideo = () => {
      if (localStreamRef.current) {
          const track = localStreamRef.current.getVideoTracks()[0];
          if(track) { track.enabled = !track.enabled; setIsVideoOff(!track.enabled); }
      }
  };

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      if(connectionStatus === 'connected') setCallDuration((p) => p + 1)
    }, 1000);
    return () => clearInterval(interval);
  }, [connectionStatus]);
  
  // Helpers
  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };
  
  // Drag logic (Simplified for space)
  const handleDragStart = (e) => { 
      if (!isMinimized) return;
      isDragging.current = true; 
      dragStart.current = { x: e.clientX - dragPosition.x, y: e.clientY - dragPosition.y }; 
  };
  const handleResizeStart = (e) => { e.stopPropagation(); isResizing.current = true; resizeStart.current = { x: e.clientX, y: e.clientY, w: pipSize.width, h: pipSize.height }; };
  useEffect(() => {
      const move = (e) => {
          if(isDragging.current) setDragPosition({x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y});
          if(isResizing.current) setPipSize({width: resizeStart.current.w + (e.clientX - resizeStart.current.x), height: resizeStart.current.h + (e.clientY - resizeStart.current.y)});
      };
      const up = () => { isDragging.current = false; isResizing.current = false; };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const userInitial = activeCall.otherUserName?.charAt(0).toUpperCase() || "U";

  // --- RENDER ---
  return (
    <>
      {/* 1. Minimized View (PiP) */}
      <div
        className={`fixed z-50 transition-opacity duration-300 ${isMinimized ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        style={{ top: dragPosition.y, left: dragPosition.x, width: pipSize.width, height: pipSize.height }}
      >
        <div 
          onMouseDown={handleDragStart}
          className="relative w-full h-full rounded-2xl overflow-hidden shadow-2xl border-2 border-white/20 bg-slate-900 flex flex-col"
        >
          <video ref={remoteVideoMiniRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover" />
           <div className="absolute bottom-2 right-2 w-[30%] aspect-[3/4] bg-slate-800 rounded-lg overflow-hidden border border-white/20 z-10 shadow-lg">
            <video ref={localVideoMiniRef} autoPlay muted playsInline className={`w-full h-full object-cover ${isVideoOff ? "opacity-0" : "opacity-100"}`} />
          </div>
           <div className="absolute top-2 right-2 z-20"><button onClick={() => setIsMinimized(false)} className="p-1 bg-black/50 rounded-full text-white"><IoExpand /></button></div>
           <div onMouseDown={handleResizeStart} className="absolute bottom-0 right-0 w-6 h-6 z-30 cursor-se-resize bg-transparent" />
        </div>
      </div>

      {/* 2. Full Screen View */}
      <div
        className={`fixed inset-0 z-50 bg-black flex flex-col transition-all duration-300 ${isMinimized ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
        onMouseMove={() => setShowControls(true)}
      >
        <div className="relative flex-1 bg-slate-900 flex items-center justify-center">
          <video ref={remoteVideoFullRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-contain" />

          {/* Status Overlay */}
          {(callStatus === "ringing" || connectionStatus === "initializing" || connectionStatus === "connecting") && (
             <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="w-24 h-24 rounded-full bg-slate-700 flex items-center justify-center text-4xl text-white font-bold mb-4 animate-pulse">
                  {userInitial}
                </div>
                <h3 className="text-white text-xl font-semibold mb-2">
                   {callStatus === "ringing" ? "Calling..." : "Connecting..."}
                </h3>
                {connectionStatus === "failed" && (
                    <button onClick={() => { if(pc.current) pc.current.restartIce(); setConnectionStatus("reconnecting"); }} className="px-4 py-2 bg-blue-600 rounded-full text-white flex items-center gap-2 hover:bg-blue-700">
                        <IoRefresh /> Retry
                    </button>
                )}
             </div>
          )}

           {mediaError && (
             <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-red-500/90 text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-3">
                 <IoWarning className="text-2xl" /> <span>{mediaError}</span>
             </div>
           )}

          {/* Controls */}
          <div className={`absolute top-0 left-0 right-0 p-6 transition-opacity duration-300 z-20 ${showControls ? "opacity-100" : "opacity-0"}`}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-white drop-shadow-md">{activeCall.otherUserName}</h3>
                {connectionStatus === "connected" && (
                    <div className="flex items-center gap-2 mt-1">
                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        <span className="text-sm text-white/80 font-mono">{formatDuration(callDuration)}</span>
                    </div>
                )}
              </div>
              <button onClick={() => setIsMinimized(true)} className="p-3 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md text-white transition-all"><IoChevronDown size={24} /></button>
            </div>
          </div>

          {/* Local PiP */}
          <div className={`absolute bottom-32 right-6 w-36 h-48 bg-black rounded-xl overflow-hidden border-2 border-white/20 z-20 shadow-2xl transition-opacity duration-300 ${showControls ? "opacity-100" : "opacity-0"}`}>
            <video ref={localVideoPipRef} autoPlay muted playsInline className={`w-full h-full object-cover ${isVideoOff ? "opacity-0" : "opacity-100"}`} />
            {isVideoOff && <div className="absolute inset-0 flex items-center justify-center bg-slate-800 text-white/50"><IoVideocamOff size={32} /></div>}
          </div>
        </div>

        {/* Bottom Bar */}
        <div className={`bg-slate-900/90 backdrop-blur-md border-t border-white/10 transition-transform duration-300 z-30 ${showControls ? "translate-y-0" : "translate-y-full"}`}>
          <div className="flex items-center justify-center gap-8 py-6">
             <button onClick={toggleAudio} className={`w-14 h-14 rounded-full flex items-center justify-center text-xl transition-all ${isMuted ? "bg-white text-slate-900" : "bg-slate-700 text-white hover:bg-slate-600"}`}>{isMuted ? <IoMicOff /> : <IoMic />}</button>
             <button onClick={endCall} className="w-20 h-20 rounded-full bg-red-500 flex items-center justify-center text-3xl text-white shadow-lg hover:bg-red-600 hover:scale-105 transition-all"><IoCall className="rotate-[135deg]" /></button>
             <button onClick={toggleVideo} className={`w-14 h-14 rounded-full flex items-center justify-center text-xl transition-all ${isVideoOff ? "bg-white text-slate-900" : "bg-slate-700 text-white hover:bg-slate-600"}`}>{isVideoOff ? <IoVideocamOff /> : <IoVideocam />}</button>
          </div>
        </div>
      </div>
    </>
  );
};

export default VideoCallScreen;