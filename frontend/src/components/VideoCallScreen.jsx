import { useState, useEffect, useRef, useCallback } from "react";
import {
  IoCall,
  IoMicOff,
  IoMic,
  IoVideocamOff,
  IoVideocam,
  IoChevronDown,
  IoExpand,
  IoSwapHorizontal,
  IoResize,
} from "react-icons/io5";
import useAppStore from "@/store";
import useMediaStream from "@/hooks/useMediaStream";
import usePeerConnection from "@/hooks/usePeerConnection";
import { useSocket } from "@/context/SocketContext";

const VideoCallScreen = () => {
  const {
    activeCall,
    activeCall: { isCaller },
    clearActiveCall,
  } = useAppStore();
  const { socket } = useSocket();
  const { startMedia, stopMedia, localStreamRef } = useMediaStream();
  const { createPeerConnection, addLocalTracks, closeConnection, pcRef } =
    usePeerConnection();

  // --- UI STATE ---
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [pipSize, setPipSize] = useState({ width: 192, height: 288 });
  const [dragPosition, setDragPosition] = useState({ x: 16, y: 16 });

  // --- LOGIC STATE ---
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isCallAccepted, setIsCallAccepted] = useState(false);

  // --- REFS ---
  const remoteVideoFullRef = useRef(null);
  const remoteVideoMiniRef = useRef(null);
  const localVideoPipRef = useRef(null);
  const localVideoMiniRef = useRef(null);
  const callInitiated = useRef(false);

  // Drag/Resize Refs
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // --- 1. END CALL HANDLER ---
  const endCall = useCallback(() => {
    const targetId = activeCall?.otherUserId || activeCall?.callerId;
    if (targetId) socket.emit("call:end", { to: targetId });

    closeConnection();
    stopMedia();
    clearActiveCall();

    callInitiated.current = false;
    setLocalStream(null);
    setRemoteStream(null);
    setIsCallAccepted(false);
  }, [activeCall, closeConnection, stopMedia, clearActiveCall, socket]);

  if (!activeCall || activeCall.callType !== "video") return null;

  // --- 2. INITIALIZE MEDIA ---
  useEffect(() => {
    let mounted = true;
    startMedia("video").then((stream) => {
      if (!mounted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setLocalStream(stream);
    });
    return () => {
      mounted = false;
      stopMedia();
    };
  }, []);

  // --- 3. CALL STATUS LISTENERS ---
  useEffect(() => {
    if (!socket) return;

    const handleCallAccepted = () => setIsCallAccepted(true);
    const handleRemoteHangup = () => endCall();

    if (!activeCall.isCaller) setIsCallAccepted(true);

    socket.on("call-accepted", handleCallAccepted);
    socket.on("call:end", handleRemoteHangup);

    return () => {
      socket.off("call-accepted", handleCallAccepted);
      socket.off("call:end", handleRemoteHangup);
    };
  }, [socket, activeCall.isCaller, endCall]);

  // --- 4. WEBRTC HANDSHAKE (INITIATOR) ---
  useEffect(() => {
    if (
      !activeCall.isCaller ||
      !socket ||
      !localStream ||
      !isCallAccepted ||
      callInitiated.current
    )
      return;

    callInitiated.current = true;

    const startCall = async () => {
      const pc = await createPeerConnection(
        (candidate) =>
          socket.emit("call:ice-candidate", {
            to: activeCall.otherUserId,
            candidate,
          }),
        (stream) => setRemoteStream(stream),
      );

      addLocalTracks(localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("call:offer", { to: activeCall.otherUserId, offer });
    };

    startCall();
  }, [
    activeCall,
    socket,
    localStream,
    isCallAccepted,
    createPeerConnection,
    addLocalTracks,
  ]);

  // --- 5. WEBRTC SIGNALING (OFFER/ANSWER/ICE) ---
  useEffect(() => {
    if (!socket) return;

    const handleOffer = async ({ offer, from }) => {
      const pc = await createPeerConnection(
        (candidate) =>
          socket.emit("call:ice-candidate", { to: from, candidate }),
        (stream) => setRemoteStream(stream),
      );

      if (localStreamRef.current) addLocalTracks(localStreamRef.current);

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("call:answer", { to: from, answer });
    };

    const handleAnswer = async ({ answer }) => {
      if (pcRef.current) await pcRef.current.setRemoteDescription(answer);
    };

    const handleIce = async ({ candidate }) => {
      if (pcRef.current) await pcRef.current.addIceCandidate(candidate);
    };

    socket.on("call:offer", handleOffer);
    socket.on("call:answer", handleAnswer);
    socket.on("call:ice-candidate", handleIce);

    return () => {
      socket.off("call:offer", handleOffer);
      socket.off("call:answer", handleAnswer);
      socket.off("call:ice-candidate", handleIce);
    };
  }, [socket, createPeerConnection, addLocalTracks, localStreamRef, pcRef]);

  // --- 6. ATTACH STREAMS TO VIDEO ELEMENTS ---
  useEffect(() => {
    const attachMediaStream = (element, stream) => {
      if (element && stream && element.srcObject !== stream) {
        element.srcObject = stream;
      }
    };

    attachMediaStream(localVideoPipRef.current, localStream);
    attachMediaStream(localVideoMiniRef.current, localStream);
    attachMediaStream(remoteVideoFullRef.current, remoteStream);
    attachMediaStream(remoteVideoMiniRef.current, remoteStream);
  }, [localStream, remoteStream]);

  // --- 7. UTILS & CONTROLS ---
  useEffect(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current
      .getAudioTracks()
      .forEach((track) => (track.enabled = !isMuted));
    localStreamRef.current
      .getVideoTracks()
      .forEach((track) => (track.enabled = !isVideoOff));
  }, [isMuted, isVideoOff, localStreamRef]);

  useEffect(() => {
    if (!isCallAccepted) return;
    const interval = setInterval(() => setCallDuration((p) => p + 1), 1000);
    return () => clearInterval(interval);
  }, [isCallAccepted]);

  useEffect(() => {
    if (!showControls || isMinimized) return;
    const timer = setTimeout(() => setShowControls(false), 3000);
    return () => clearTimeout(timer);
  }, [showControls, isMinimized]);

  // --- DRAG & RESIZE HANDLERS ---
  const handleDragStart = useCallback(
    (e) => {
      if (!isMinimized || isResizing.current) return;
      e.preventDefault();
      isDragging.current = true;
      const clientX =
        e.type === "touchstart" ? e.touches[0].clientX : e.clientX;
      const clientY =
        e.type === "touchstart" ? e.touches[0].clientY : e.clientY;
      dragStart.current = {
        x: clientX - dragPosition.x,
        y: clientY - dragPosition.y,
      };
    },
    [isMinimized, dragPosition],
  );

  const handleResizeStart = useCallback(
    (e) => {
      e.stopPropagation();
      e.preventDefault();
      isResizing.current = true;
      const clientX =
        e.type === "touchstart" ? e.touches[0].clientX : e.clientX;
      const clientY =
        e.type === "touchstart" ? e.touches[0].clientY : e.clientY;
      resizeStart.current = {
        x: clientX,
        y: clientY,
        w: pipSize.width,
        h: pipSize.height,
      };
    },
    [pipSize],
  );

  useEffect(() => {
    const handleMove = (e) => {
      if (!isDragging.current && !isResizing.current) return;

      const clientX = e.type === "touchmove" ? e.touches[0].clientX : e.clientX;
      const clientY = e.type === "touchmove" ? e.touches[0].clientY : e.clientY;

      if (isDragging.current) {
        const newX = clientX - dragStart.current.x;
        const newY = clientY - dragStart.current.y;
        const maxX = window.innerWidth - pipSize.width - 16;
        const maxY = window.innerHeight - pipSize.height - 16;
        setDragPosition({
          x: Math.max(16, Math.min(newX, maxX)),
          y: Math.max(16, Math.min(newY, maxY)),
        });
      } else if (isResizing.current) {
        const deltaX = clientX - resizeStart.current.x;
        const deltaY = clientY - resizeStart.current.y;
        setPipSize({
          width: Math.max(160, Math.min(resizeStart.current.w + deltaX, 400)),
          height: Math.max(200, Math.min(resizeStart.current.h + deltaY, 600)),
        });
      }
    };

    const handleUp = () => {
      isDragging.current = false;
      isResizing.current = false;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchmove", handleMove);
    window.addEventListener("touchend", handleUp);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleUp);
    };
  }, [pipSize]);

  // --- HELPERS ---
  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const userInitial = activeCall.otherUserName?.charAt(0).toUpperCase() || "U";

  // --- RENDER: WAITING SCREEN ---
  if (activeCall.isCaller && !isCallAccepted) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center">
        <div className="absolute inset-0 overflow-hidden">
          <video
            ref={(el) => el && localStream && (el.srcObject = localStream)}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover opacity-30 blur-xl"
          />
        </div>
        <div className="relative z-10 flex flex-col items-center animate-pulse">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-6xl font-bold text-white mb-6 shadow-2xl">
            {userInitial}
          </div>
          <h2 className="text-2xl font-semibold text-white mb-2">
            {activeCall.otherUserName}
          </h2>
          <p className="text-white/70 text-lg">Calling...</p>
        </div>
        <button
          onClick={endCall}
          className="relative z-10 mt-12 w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-xl hover:bg-red-600 transition-colors"
        >
          <IoCall className="text-3xl text-white rotate-[135deg]" />
        </button>
      </div>
    );
  }

  // --- RENDER: CONNECTED SCREEN ---
  return (
    <>
      {/* 1. Minimized View (PiP) */}
      <div
        className={`fixed z-50 transition-opacity duration-300 ${isMinimized ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        style={{
          top: dragPosition.y,
          left: dragPosition.x,
          width: pipSize.width,
          height: pipSize.height,
        }}
      >
        <div
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
          className="relative w-full h-full rounded-2xl overflow-hidden shadow-2xl border-2 border-white/20 bg-slate-900 flex flex-col cursor-grab active:cursor-grabbing"
        >
          <video
            ref={remoteVideoMiniRef}
            autoPlay
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />

          {!remoteStream && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-sm">
              <div className="text-2xl font-bold text-white mb-2">
                {userInitial}
              </div>
              <span className="text-xs text-white/70">Connecting...</span>
            </div>
          )}

          <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-2 z-10 pointer-events-none">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[10px] text-white font-medium">
                {formatDuration(callDuration)}
              </span>
            </div>
          </div>

          <div className="absolute bottom-2 right-2 w-[30%] aspect-[3/4] bg-slate-900 rounded-lg overflow-hidden border border-white/20 z-10 shadow-lg">
            <video
              ref={localVideoMiniRef}
              autoPlay
              muted
              playsInline
              className={`w-full h-full object-cover ${isVideoOff ? "opacity-0" : "opacity-100"}`}
            />
          </div>

          <div className="absolute bottom-2 left-2 flex gap-2 pointer-events-auto z-10">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsMinimized(false);
              }}
              className="w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-colors"
            >
              <IoExpand className="text-white text-sm" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                endCall();
              }}
              className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors"
            >
              <IoCall className="text-white text-xs rotate-[135deg]" />
            </button>
          </div>

          <div
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            className="absolute bottom-0 right-0 w-6 h-6 z-20 cursor-nwse-resize flex items-end justify-end p-0.5 hover:bg-white/10 rounded-tl-lg group"
          >
            <IoResize className="text-white/50 group-hover:text-white text-xs rotate-90" />
          </div>
        </div>
      </div>

      {/* 2. Full Screen View */}
      <div
        className={`fixed inset-0 z-50 bg-black flex flex-col transition-all duration-300 ${isMinimized ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
        onMouseMove={() => setShowControls(true)}
        onTouchStart={() => setShowControls(true)}
      >
        {/* CHANGED: Background color to black and object-fit to 'contain' to avoid cropping/chopping */}
        <div className="relative flex-1 bg-black">
          <video
            ref={remoteVideoFullRef}
            autoPlay
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
          />
          {!remoteStream && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center">
              <div className="w-24 h-24 rounded-full bg-slate-700 flex items-center justify-center text-4xl text-white font-bold mb-4">
                {userInitial}
              </div>
              <p className="text-white/50">Connecting video...</p>
            </div>
          )}

          <div
            className={`absolute top-0 left-0 right-0 p-4 sm:p-6 transition-opacity duration-300 z-20 ${showControls ? "opacity-100" : "opacity-0"}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-white drop-shadow-md">
                  {activeCall.otherUserName}
                </h3>
                {isCallAccepted && (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-sm text-white/80">
                      {formatDuration(callDuration)}
                    </span>
                  </div>
                )}
              </div>
              <button
                onClick={() => setIsMinimized(true)}
                className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-sm border border-white/10 flex items-center justify-center hover:bg-black/50 transition-all"
              >
                <IoChevronDown className="text-white text-xl" />
              </button>
            </div>
          </div>

          <div
            className={`absolute bottom-32 right-4 w-32 h-44 bg-slate-900 rounded-xl overflow-hidden border-2 border-white/20 z-20 ${showControls ? "opacity-100" : "opacity-0"} transition-opacity duration-300 shadow-2xl`}
          >
            <video
              ref={localVideoPipRef}
              autoPlay
              muted
              playsInline
              className={`w-full h-full object-cover ${isVideoOff ? "opacity-0" : "opacity-100"}`}
            />
            {isVideoOff && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900">
                <IoVideocamOff className="text-2xl text-slate-400" />
              </div>
            )}
          </div>
        </div>

        <div
          className={`transition-transform duration-300 z-20 ${showControls ? "translate-y-0" : "translate-y-full"} bg-black/80 backdrop-blur-md`}
        >
          <div className="px-4 py-8 flex justify-center gap-6">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`w-14 h-14 rounded-full flex items-center justify-center ${isMuted ? "bg-red-500/20 text-red-500" : "bg-white/10 text-white"}`}
            >
              {isMuted ? <IoMicOff size={24} /> : <IoMic size={24} />}
            </button>
            <button
              onClick={() => setIsVideoOff(!isVideoOff)}
              className={`w-14 h-14 rounded-full flex items-center justify-center ${isVideoOff ? "bg-red-500/20 text-red-500" : "bg-white/10 text-white"}`}
            >
              {isVideoOff ? (
                <IoVideocamOff size={24} />
              ) : (
                <IoVideocam size={24} />
              )}
            </button>
            <button
              onClick={endCall}
              className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg hover:bg-red-600 scale-105"
            >
              <IoCall size={32} className="text-white rotate-[135deg]" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default VideoCallScreen;
