import { useState, useEffect, useRef, useCallback } from "react";
import {
  IoCall,
  IoMicOff,
  IoMic,
  IoVideocamOff,
  IoVideocam,
  IoChevronDown,
  IoExpand,
  IoRefresh,
  IoPerson,
  IoWarning,
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
  const { activeCall, clearActiveCall } = useAppStore();
  const { socket } = useSocket();

  // --- UI STATE ---
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Connection State
  const [callStatus, setCallStatus] = useState(
    activeCall.isCaller ? "ringing" : "connected"
  );
  const [connectionStatus, setConnectionStatus] = useState("initializing");
  const [mediaError, setMediaError] = useState(null);

  // PiP / Drag State
  const [pipSize, setPipSize] = useState({ width: 120, height: 180 });
  const [dragPosition, setDragPosition] = useState({ x: 16, y: 16 });

  // --- WEBRTC REFS ---
  const pc = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  
  // --- ROBUSTNESS BUFFERS ---
  // These hold signals that arrive BEFORE the camera is ready
  const pendingOffer = useRef(null);
  const pendingCandidates = useRef([]); 
  
  const makingOffer = useRef(false);
  const ignoreOffer = useRef(false);
  const isPolite = useRef(!activeCall.isCaller);

  // UI Refs
  const remoteVideoFullRef = useRef(null);
  const remoteVideoMiniRef = useRef(null);
  const localVideoPipRef = useRef(null);
  const localVideoMiniRef = useRef(null);
  
  // Drag Logic Refs
  const isDragging = useRef(false);
  const hasDragged = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  if (!activeCall || activeCall.callType !== "video") return null;

  // --- 0. RESPONSIVE SETUP ---
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const newPipSize = width > 768 ? { width: 220, height: 330 } : { width: 130, height: 200 };
      setPipSize(newPipSize);
      setDragPosition((prev) => ({
        x: Math.max(16, Math.min(prev.x, width - newPipSize.width - 16)),
        y: Math.max(16, Math.min(prev.y, height - newPipSize.height - 16)),
      }));
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // --- 1. MEDIA INIT ---
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

        // Receiver: Initialize PC immediately to be ready for the buffered offer
        if (!activeCall.isCaller) {
          initializePeerConnection(stream);
        }
      } catch (err) {
        console.error("Media Error:", err);
        setMediaError("Camera/Mic access denied.");
      }
    };
    startMedia();
    return () => cleanup();
  }, []);

  // --- 2. CALLER TRIGGER ---
  useEffect(() => {
    if (!socket || !activeCall.isCaller) return;
    const handleCallAccepted = () => {
      setCallStatus("connected");
      // Caller: Only init PC once accepted
      if (localStreamRef.current) initializePeerConnection(localStreamRef.current);
    };
    socket.on("call-accepted", handleCallAccepted);
    return () => socket.off("call-accepted", handleCallAccepted);
  }, [socket, activeCall.isCaller]);

  // --- 3. ROBUST PEER CONNECTION LOGIC ---
  const initializePeerConnection = async (stream) => {
    if (pc.current) return;
    
    console.log("Initializing Peer Connection...");
    pc.current = new RTCPeerConnection(ICE_SERVERS);

    // A. Add Local Tracks
    stream.getTracks().forEach((track) => pc.current.addTrack(track, stream));

    // B. Handle Remote Stream
    pc.current.ontrack = ({ track }) => {
      console.log("Track received:", track.kind);
      remoteStreamRef.current.addTrack(track);
      const refresh = (el) => {
        if (el && el.srcObject !== remoteStreamRef.current) {
          el.srcObject = remoteStreamRef.current;
          el.play().catch(e => console.log("Autoplay error", e));
        }
      };
      refresh(remoteVideoFullRef.current);
      refresh(remoteVideoMiniRef.current);
    };

    // C. ICE Candidates
    pc.current.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit("call:ice-candidate", { 
        to: activeCall.otherUserId || activeCall.callerId, candidate 
      });
    };

    // D. Connection Health
    pc.current.oniceconnectionstatechange = () => {
      setConnectionStatus(pc.current.iceConnectionState);
      if (pc.current.iceConnectionState === "failed") {
        pc.current.restartIce();
      }
    };

    // E. Perfect Negotiation Trigger
    pc.current.onnegotiationneeded = async () => {
      try {
        makingOffer.current = true;
        await pc.current.setLocalDescription();
        socket.emit("call:offer", {
          to: activeCall.otherUserId || activeCall.callerId,
          description: pc.current.localDescription,
        });
      } catch (err) {
        console.error(err);
      } finally {
        makingOffer.current = false;
      }
    };

    // F. FLUSH BUFFER (Critical Fix)
    // If an offer arrived while we were getting the camera, handle it now.
    if (pendingOffer.current) {
        console.log("Processing Buffered Offer...");
        await handleDescription(pendingOffer.current.description, pendingOffer.current.from);
        pendingOffer.current = null;
    }
    // Flush buffered candidates
    while (pendingCandidates.current.length > 0) {
        const candidate = pendingCandidates.current.shift();
        await pc.current.addIceCandidate(candidate);
    }
  };

  // --- 4. SIGNALING HANDLER (Buffering Logic) ---
  // We define this outside useEffect so we can call it from initializePeerConnection
  const handleDescription = async (description, from) => {
    const peer = pc.current;
    
    // 1. BUFFERING: If PC is not ready, save the offer for later
    if (!peer) {
        console.log("Buffering Offer (PC not ready)");
        pendingOffer.current = { description, from };
        return;
    }

    try {
      const offerCollision = description.type === "offer" && 
                             (makingOffer.current || peer.signalingState !== "stable");

      ignoreOffer.current = !isPolite.current && offerCollision;
      if (ignoreOffer.current) return;

      if (offerCollision) {
        await Promise.all([
          peer.setLocalDescription({ type: "rollback" }),
          peer.setRemoteDescription(description)
        ]);
      } else {
        await peer.setRemoteDescription(description);
      }

      if (description.type === "offer") {
        await peer.setLocalDescription();
        socket.emit("call:answer", { to: from, description: peer.localDescription });
      }
    } catch (err) {
      console.error("Signaling Error:", err);
    }
  };

  useEffect(() => {
    if (!socket) return;

    // Wrapper for socket event
    const onDescription = ({ description, from }) => handleDescription(description, from);

    const onCandidate = async ({ candidate }) => {
      if (pc.current && pc.current.remoteDescription) {
         try { await pc.current.addIceCandidate(candidate); } catch (e) { console.error(e); }
      } else {
         console.log("Buffering Candidate");
         pendingCandidates.current.push(candidate);
      }
    };

    const onEnd = () => cleanup();

    socket.on("call:offer", onDescription);
    socket.on("call:answer", onDescription);
    socket.on("call:ice-candidate", onCandidate);
    socket.on("call:end", onEnd);

    return () => {
      socket.off("call:offer", onDescription);
      socket.off("call:answer", onDescription);
      socket.off("call:ice-candidate", onCandidate);
      socket.off("call:end", onEnd);
    };
  }, [socket]);

  // --- 5. CLEANUP ---
  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    pc.current?.close();
    pc.current = null;
    clearActiveCall();
    setConnectionStatus("disconnected");
  }, [clearActiveCall]);

  const endCall = () => {
    const to = activeCall?.otherUserId || activeCall?.callerId;
    if (to) socket.emit("call:end", { to });
    cleanup();
  };

  // --- UTILS ---
  const updateLocalVideoRefs = (stream) => {
    [localVideoPipRef.current, localVideoMiniRef.current].forEach(el => {
      if (el) { el.srcObject = stream; el.muted = true; }
    });
  };
  const toggleAudio = () => {
    const t = localStreamRef.current?.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; setIsMuted(!t.enabled); }
  };
  const toggleVideo = () => {
    const t = localStreamRef.current?.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; setIsVideoOff(!t.enabled); }
  };
  useEffect(() => {
    const t = setInterval(() => { if (connectionStatus === "connected") setCallDuration(p => p+1); }, 1000);
    return () => clearInterval(t);
  }, [connectionStatus]);
  const formatDuration = (s) => `${Math.floor(s/60).toString().padStart(2,"0")}:${(s%60).toString().padStart(2,"0")}`;

  // --- DRAG LOGIC ---
  const handleDragStart = (e) => {
    if (e.target.closest("button")) return;
    isDragging.current = true;
    hasDragged.current = false;
    const clientX = e.clientX || e.touches?.[0]?.clientX;
    const clientY = e.clientY || e.touches?.[0]?.clientY;
    dragStart.current = { x: clientX - dragPosition.x, y: clientY - dragPosition.y };
  };
  const handleDragMove = useCallback((e) => {
    if (!isDragging.current) return;
    hasDragged.current = true;
    if (e.type === 'touchmove') e.preventDefault();
    const clientX = e.clientX || e.touches?.[0]?.clientX;
    const clientY = e.clientY || e.touches?.[0]?.clientY;
    const maxX = window.innerWidth - pipSize.width - 16;
    const maxY = window.innerHeight - pipSize.height - 16;
    setDragPosition({
      x: Math.max(16, Math.min(clientX - dragStart.current.x, maxX)),
      y: Math.max(16, Math.min(clientY - dragStart.current.y, maxY)),
    });
  }, [pipSize]);
  const handleDragEnd = () => isDragging.current = false;
  useEffect(() => {
    window.addEventListener("mousemove", handleDragMove);
    window.addEventListener("touchmove", handleDragMove, { passive: false });
    window.addEventListener("mouseup", handleDragEnd);
    window.addEventListener("touchend", handleDragEnd);
    return () => {
      window.removeEventListener("mousemove", handleDragMove);
      window.removeEventListener("touchmove", handleDragMove);
      window.removeEventListener("mouseup", handleDragEnd);
      window.removeEventListener("touchend", handleDragEnd);
    };
  }, [handleDragMove]);

  // --- RENDER ---
  return (
    <>
      <div className={`fixed z-[9999] transition-opacity duration-300 ${isMinimized ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        style={{ top: dragPosition.y, left: dragPosition.x, width: pipSize.width, height: pipSize.height, touchAction: 'none' }}>
        <div onMouseDown={handleDragStart} onTouchStart={handleDragStart} onClick={() => !hasDragged.current && setIsMinimized(false)}
          className="relative w-full h-full rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 bg-black cursor-move active:scale-95 transition-transform">
          <video ref={remoteVideoMiniRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/50 to-transparent pointer-events-none" />
          <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 backdrop-blur px-2 py-1 rounded-full border border-white/10 z-10">
             <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
             <span className="text-[10px] text-white font-mono">{formatDuration(callDuration)}</span>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setIsMinimized(false); }} className="absolute top-2 right-2 p-1.5 bg-black/60 backdrop-blur rounded-full text-white z-20 active:bg-white/20"><IoExpand size={14} /></button>
          <div className="absolute bottom-3 left-0 right-0 flex justify-center z-10">
             <button onClick={(e) => { e.stopPropagation(); endCall(); }} className="w-9 h-9 rounded-full bg-red-500 flex items-center justify-center text-white shadow-lg active:scale-90 transition-transform"><IoCall size={16} className="rotate-[135deg]" /></button>
          </div>
        </div>
      </div>

      <div className={`fixed inset-0 z-50 bg-slate-950 flex flex-col transition-all duration-300 ${isMinimized ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
        onMouseMove={() => setShowControls(true)} onClick={() => setShowControls(p => !p)}>
        <div className="relative flex-1 w-full h-full flex items-center justify-center bg-black overflow-hidden">
          <video ref={remoteVideoFullRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover md:object-contain transition-all" />
          
          {(callStatus === "ringing" || (connectionStatus !== "connected" && connectionStatus !== "completed")) && (
             <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-xl">
                 <div className="relative w-32 h-32 rounded-full bg-slate-800 flex items-center justify-center mb-6 ring-4 ring-white/10 shadow-2xl">
                    <span className="text-4xl text-white font-bold">{activeCall.otherUserName?.charAt(0)}</span>
                    <div className="absolute inset-0 rounded-full border-4 border-blue-500/50 animate-ping" />
                 </div>
                 <h2 className="text-2xl text-white font-bold mb-2">{activeCall.otherUserName}</h2>
                 <p className="text-blue-300 animate-pulse">{connectionStatus === "failed" ? "Connection Failed" : "Connecting..."}</p>
                 {connectionStatus === "failed" && (
                    <button onClick={(e) => { e.stopPropagation(); pc.current?.restartIce(); }} className="mt-6 px-6 py-2 bg-white/10 rounded-full text-white flex gap-2 items-center hover:bg-white/20"><IoRefresh /> Retry</button>
                 )}
             </div>
          )}

          {mediaError && <div className="absolute top-24 left-1/2 -translate-x-1/2 z-50 bg-red-500/90 backdrop-blur text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-3"><IoWarning className="text-2xl" /> <span>{mediaError}</span></div>}

          <div className={`absolute top-0 left-0 right-0 p-4 md:p-8 bg-gradient-to-b from-black/80 to-transparent flex justify-between items-start z-30 transition-transform duration-300 ${showControls ? "translate-y-0" : "-translate-y-full"}`}>
              <div className="flex flex-col">
                  <h3 className="text-white font-bold text-lg drop-shadow">{activeCall.otherUserName}</h3>
                  <span className="text-white/70 text-sm font-mono">{formatDuration(callDuration)}</span>
              </div>
              <button onClick={(e) => { e.stopPropagation(); setIsMinimized(true); }} className="p-3 bg-white/10 backdrop-blur rounded-full text-white hover:bg-white/20 transition-all"><IoChevronDown size={24} /></button>
          </div>

          <div className={`absolute bottom-32 right-4 w-32 h-48 md:w-48 md:h-72 bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/20 z-30 transition-all duration-300 ${showControls ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0"}`}>
             <video ref={localVideoPipRef} autoPlay muted playsInline className={`w-full h-full object-cover transform scale-x-[-1] ${isVideoOff ? "opacity-0" : "opacity-100"}`} />
             {isVideoOff && <div className="absolute inset-0 flex items-center justify-center bg-slate-800 text-white/50"><IoPerson size={40} /></div>}
          </div>
        </div>

        <div onClick={e => e.stopPropagation()} className={`absolute bottom-0 left-0 right-0 p-8 bg-gradient-to-t from-black/90 to-transparent flex justify-center z-40 transition-transform duration-300 ${showControls ? "translate-y-0" : "translate-y-full"}`}>
            <div className="flex items-center gap-6 px-8 py-4 bg-white/10 backdrop-blur-2xl rounded-full border border-white/5 shadow-2xl">
                <button onClick={toggleAudio} className={`p-4 rounded-full transition-all ${isMuted ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20"}`}>{isMuted ? <IoMicOff size={24}/> : <IoMic size={24}/>}</button>
                <button onClick={endCall} className="p-5 bg-red-500 rounded-full text-white hover:bg-red-600 shadow-lg active:scale-95 transition-all mx-2"><IoCall size={32} className="rotate-[135deg]"/></button>
                <button onClick={toggleVideo} className={`p-4 rounded-full transition-all ${isVideoOff ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20"}`}>{isVideoOff ? <IoVideocamOff size={24}/> : <IoVideocam size={24}/>}</button>
            </div>
        </div>
      </div>
    </>
  );
};

export default VideoCallScreen;