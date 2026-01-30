import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Phone,
  PhoneOff,
  MicOff,
  Mic,
  VideoOff,
  Video,
  ChevronDown,
  Maximize2,
  Minimize2,
  RefreshCw,
  User,
  AlertCircle,
  Signal,
  SignalLow,
  SignalZero,
} from "lucide-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { GET_TURN_CREDENTIALS } from "@/utils/constants";
import { cn } from "@/lib/utils";

const VideoCallScreen = () => {
  const { activeCall, clearActiveCall } = useAppStore();
  const { socket } = useSocket();

  // UI STATE
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [pipExpanded, setPipExpanded] = useState(false);

  // Connection State
  const [callStatus, setCallStatus] = useState(
    activeCall?.isCaller ? "ringing" : "connected"
  );
  const [connectionStatus, setConnectionStatus] = useState("initializing");
  const [mediaError, setMediaError] = useState(null);

  // --- FIX 2: Switched to Top/Left for correct drag behavior ---
  const [dragPosition, setDragPosition] = useState({ x: 20, y: 20 }); 

  // WEBRTC REFS
  const pc = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const connectionTimeout = useRef(null);

  // ROBUSTNESS BUFFERS
  const pendingOffer = useRef(null);
  const pendingCandidates = useRef([]);
  const makingOffer = useRef(false);
  const ignoreOffer = useRef(false);
  const isPolite = useRef(!activeCall?.isCaller);

  // UI Refs
  const remoteVideoFullRef = useRef(null);
  const remoteVideoMiniRef = useRef(null);
  const localVideoPipRef = useRef(null);
  const localVideoMiniRef = useRef(null);

  // Drag Logic Refs
  const isDragging = useRef(false);
  const hasDragged = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  // PiP sizes
  const pipSize = pipExpanded
    ? { width: 200, height: 280 }
    : { width: 120, height: 160 };

  if (!activeCall || activeCall.callType !== "video") return null;

  // --- FIX 1: Re-attach streams when switching views ---
  // This effect runs whenever you minimize/maximize to ensure the new video tags get the stream
  useEffect(() => {
    // Attach Local Stream
    if (localStreamRef.current) {
        if (localVideoPipRef.current) {
            localVideoPipRef.current.srcObject = localStreamRef.current;
            localVideoPipRef.current.muted = true;
        }
        if (localVideoMiniRef.current) {
            localVideoMiniRef.current.srcObject = localStreamRef.current;
            localVideoMiniRef.current.muted = true;
        }
    }
    // Attach Remote Stream
    if (remoteStreamRef.current) {
        if (remoteVideoFullRef.current) remoteVideoFullRef.current.srcObject = remoteStreamRef.current;
        if (remoteVideoMiniRef.current) remoteVideoMiniRef.current.srcObject = remoteStreamRef.current;
    }
  }, [isMinimized, connectionStatus]); // Trigger on mode switch


  // RESTART MEDIA ON DEVICE CHANGE
  const handleDeviceChange = async () => {
    console.log("Device change detected. Refreshing stream...");
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = newStream;
      updateLocalVideoRefs(newStream);

      if (pc.current) {
        const senders = pc.current.getSenders();
        newStream.getTracks().forEach((newTrack) => {
          const sender = senders.find((s) => s.track?.kind === newTrack.kind);
          if (sender) sender.replaceTrack(newTrack);
        });
      }
    } catch (err) {
      console.error("Failed to refresh media on device change", err);
      setMediaError("Device disconnected. Please check camera/mic.");
    }
  };

  // INITIALIZE MEDIA
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

        stream.getTracks().forEach((track) => {
          track.onended = () => {
            console.warn("Track ended unexpectedly. Restarting media...");
            handleDeviceChange();
          };
        });

        if (!activeCall.isCaller) initializePeerConnection(stream);
      } catch (err) {
        console.error("Media Error:", err);
        setMediaError("Camera/Mic access denied.");
      }
    };
    startMedia();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      cleanup();
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange
      );
    };
  }, []);

  // CALLER TRIGGER
  useEffect(() => {
    if (!socket || !activeCall.isCaller) return;
    const handleCallAccepted = () => {
      setCallStatus("connected");
      if (localStreamRef.current)
        initializePeerConnection(localStreamRef.current);
    };
    socket.on("call-accepted", handleCallAccepted);
    return () => socket.off("call-accepted", handleCallAccepted);
  }, [socket, activeCall.isCaller]);

  // HANDLE TAB CLOSE
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (activeCall) {
        const targetId = activeCall.otherUserId || activeCall.callerId;
        socket.emit("call:end", { to: targetId });
      }
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [activeCall, socket]);

  // PEER CONNECTION LOGIC
  const initializePeerConnection = async (stream) => {
    if (pc.current) return;
    let config = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
      ],
    };

    try {
      const response = await axios.get(GET_TURN_CREDENTIALS, {
        withCredentials: true,
      });
      if (response.data.success && response.data.iceServers) {
        config.iceServers = response.data.iceServers;
      }
    } catch (error) {
      console.error("Failed to fetch TURN credentials:", error);
    }

    pc.current = new RTCPeerConnection(config);
    stream
      .getTracks()
      .forEach((track) => pc.current.addTrack(track, stream));

    pc.current.ontrack = ({ track }) => {
      remoteStreamRef.current.addTrack(track);
      const refresh = (el) => {
        if (el && el.srcObject !== remoteStreamRef.current) {
          el.srcObject = remoteStreamRef.current;
          el.play().catch((e) => console.log("Autoplay error", e));
        }
      };
      refresh(remoteVideoFullRef.current);
      refresh(remoteVideoMiniRef.current);
    };

    pc.current.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit("call:ice-candidate", {
          to: activeCall.otherUserId || activeCall.callerId,
          candidate,
        });
      }
    };

    pc.current.oniceconnectionstatechange = () => {
      const state = pc.current.iceConnectionState;
      setConnectionStatus(state);
      if (connectionTimeout.current) {
        clearTimeout(connectionTimeout.current);
        connectionTimeout.current = null;
      }

      if (state === "disconnected") {
        connectionTimeout.current = setTimeout(() => {
          if (pc.current?.iceConnectionState === "disconnected") {
            pc.current.restartIce();
          }
        }, 2000);
      } else if (state === "failed") {
        pc.current.restartIce();
      }
    };

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

    if (pendingOffer.current) {
      await handleDescription(
        pendingOffer.current.description,
        pendingOffer.current.from
      );
      pendingOffer.current = null;
    }

    while (pendingCandidates.current.length > 0) {
      const candidate = pendingCandidates.current.shift();
      await pc.current.addIceCandidate(candidate);
    }
  };

  const handleDescription = async (description, from) => {
    const peer = pc.current;
    if (!peer) {
      pendingOffer.current = { description, from };
      return;
    }

    try {
      const offerCollision =
        description.type === "offer" &&
        (makingOffer.current || peer.signalingState !== "stable");

      ignoreOffer.current = !isPolite.current && offerCollision;
      if (ignoreOffer.current) return;

      if (offerCollision) {
        await Promise.all([
          peer.setLocalDescription({ type: "rollback" }),
          peer.setRemoteDescription(description),
        ]);
      } else {
        await peer.setRemoteDescription(description);
      }

      if (description.type === "offer") {
        await peer.setLocalDescription();
        socket.emit("call:answer", {
          to: from,
          description: peer.localDescription,
        });
      }
    } catch (err) {
      console.error("Signaling Error:", err);
    }
  };

  useEffect(() => {
    if (!socket) return;
    const onDescription = ({ description, from }) =>
      handleDescription(description, from);
    const onCandidate = async ({ candidate }) => {
      if (pc.current?.remoteDescription) {
        try {
          await pc.current.addIceCandidate(candidate);
        } catch (e) {
          console.error(e);
        }
      } else {
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

  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pc.current?.close();
    pc.current = null;
    if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
    clearActiveCall();
    setConnectionStatus("disconnected");
  }, [clearActiveCall]);

  const endCall = () => {
    const to = activeCall?.otherUserId || activeCall?.callerId;
    if (to) socket.emit("call:end", { to });
    cleanup();
  };

  const updateLocalVideoRefs = (stream) => {
    [localVideoPipRef.current, localVideoMiniRef.current].forEach((el) => {
      if (el) {
        el.srcObject = stream;
        el.muted = true;
      }
    });
  };

  const toggleAudio = () => {
    const t = localStreamRef.current?.getAudioTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      setIsMuted(!t.enabled);
    }
  };

  const toggleVideo = () => {
    const t = localStreamRef.current?.getVideoTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      setIsVideoOff(!t.enabled);
    }
  };

  useEffect(() => {
    const t = setInterval(() => {
      if (connectionStatus === "connected") setCallDuration((p) => p + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [connectionStatus]);

  const formatDuration = (s) =>
    `${Math.floor(s / 60)
      .toString()
      .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  // --- FIX 2: Corrected Drag Handlers (Using Top/Left) ---
  const handleDragStart = (e) => {
    if (e.target.closest("button")) return;
    isDragging.current = true;
    hasDragged.current = false;
    
    // Get mouse/touch start position
    const clientX = e.clientX || e.touches?.[0]?.clientX;
    const clientY = e.clientY || e.touches?.[0]?.clientY;
    
    // Store the difference between mouse pos and element's top/left
    dragStart.current = {
      x: clientX - dragPosition.x,
      y: clientY - dragPosition.y
    };
  };

  const handleDragMove = useCallback(
    (e) => {
      if (!isDragging.current) return;
      hasDragged.current = true;
      if (e.type === "touchmove") e.preventDefault();
      
      const clientX = e.clientX || e.touches?.[0]?.clientX;
      const clientY = e.clientY || e.touches?.[0]?.clientY;

      const maxX = window.innerWidth - pipSize.width - 16;
      const maxY = window.innerHeight - pipSize.height - 16;
      
      // With Top/Left, the math matches the mouse movement
      const newX = clientX - dragStart.current.x;
      const newY = clientY - dragStart.current.y;

      setDragPosition({
        x: Math.max(16, Math.min(newX, maxX)),
        y: Math.max(16, Math.min(newY, maxY)),
      });
    },
    [pipSize]
  );

  const handleDragEnd = () => (isDragging.current = false);

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

  const getConnectionIcon = () => {
    switch (connectionStatus) {
      case "connected":
      case "completed":
        return <Signal className="w-3.5 h-3.5 text-status-online" />;
      case "checking":
      case "new":
        return <SignalLow className="w-3.5 h-3.5 text-yellow-400" />;
      default:
        return <SignalZero className="w-3.5 h-3.5 text-destructive" />;
    }
  };

  const isConnecting =
    callStatus === "ringing" ||
    (connectionStatus !== "connected" && connectionStatus !== "completed");

  return (
    <>
      {/* MINIMIZED PIP VIEW */}
      <AnimatePresence>
        {isMinimized && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            style={{
              position: "fixed",
              left: dragPosition.x, // Changed from right to left
              top: dragPosition.y,  // Changed from bottom to top
              width: pipSize.width,
              height: pipSize.height,
              zIndex: 9999,
            }}
            onMouseDown={handleDragStart}
            onTouchStart={handleDragStart}
            className="select-none"
          >
            <motion.div
              layout
              transition={{ type: "spring", damping: 20, stiffness: 200 }}
              onClick={() => !hasDragged.current && setIsMinimized(false)}
              className={cn(
                "relative w-full h-full rounded-2xl overflow-hidden",
                "bg-background-secondary ring-1 ring-border",
                "shadow-chat-lg cursor-move",
                "active:ring-2 active:ring-primary/50"
              )}
            >
              {/* Remote Video */}
              <video
                ref={remoteVideoMiniRef}
                autoPlay
                playsInline
                className="absolute inset-0 w-full h-full object-cover"
              />
              
              {/* ... (rest of the mini UI is same) ... */}
              
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />
              
              <div className="absolute top-2 left-2 right-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/40 backdrop-blur-sm">
                  {getConnectionIcon()}
                  <span className="text-[10px] font-medium text-white">
                    {formatDuration(callDuration)}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPipExpanded(!pipExpanded);
                  }}
                  className="w-6 h-6 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/80 hover:text-white transition-colors"
                >
                  {pipExpanded ? (
                    <Minimize2 className="w-3 h-3" />
                  ) : (
                    <Maximize2 className="w-3 h-3" />
                  )}
                </button>
              </div>

              {/* Local Video Inset */}
              <motion.div
                layout
                className="absolute bottom-10 right-2 w-12 h-16 rounded-lg overflow-hidden ring-1 ring-white/20 shadow-md"
              >
                <video
                  ref={localVideoMiniRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              </motion.div>

              <div className="absolute bottom-2 left-0 right-0 flex justify-center">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    endCall();
                  }}
                  className="w-8 h-8 rounded-full bg-destructive flex items-center justify-center text-white shadow-lg"
                >
                  <PhoneOff className="w-4 h-4" />
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FULL SCREEN VIEW */}
      <AnimatePresence>
        {!isMinimized && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-50 bg-background"
            onClick={() => setShowControls((p) => !p)}
          >
             {/* ... (The rest of Full Screen UI remains identical) ... */}
             
            <div className="absolute inset-0">
              <video
                ref={remoteVideoFullRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              {(isConnecting || connectionStatus === "failed") && (
                <div className="absolute inset-0 bg-background-secondary" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40" />
            </div>

            <AnimatePresence>
              {isConnecting && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="absolute inset-0 flex flex-col items-center justify-center z-10"
                >
                  <div className="relative mb-6">
                    <motion.div
                      animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.2, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute inset-0 rounded-full bg-primary/30"
                      style={{ margin: "-12px" }}
                    />
                    <motion.div
                      animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.1, 0.3] }}
                      transition={{ duration: 2, repeat: Infinity, delay: 0.3 }}
                      className="absolute inset-0 rounded-full bg-primary/20"
                      style={{ margin: "-24px" }}
                    />
                    <div className="w-28 h-28 rounded-full bg-background-tertiary border-2 border-primary/50 flex items-center justify-center">
                      <span className="text-4xl font-semibold text-foreground">
                        {activeCall.otherUserName?.charAt(0)}
                      </span>
                    </div>
                  </div>
                  <h2 className="text-xl font-semibold text-foreground mb-1">
                    {activeCall.otherUserName}
                  </h2>
                  <motion.p
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                    className="text-sm text-foreground-secondary"
                  >
                    {connectionStatus === "failed" ? "Connection Failed" : "Connecting..."}
                  </motion.p>
                  {connectionStatus === "failed" && (
                    <motion.button
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        pc.current?.restartIce();
                      }}
                      className="mt-6 px-5 py-2.5 bg-primary/10 border border-primary/30 rounded-full text-primary font-medium flex items-center gap-2 hover:bg-primary/20 transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Retry Connection
                    </motion.button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {mediaError && (
                <motion.div
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="absolute top-4 left-4 right-4 z-30"
                >
                  <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-xl backdrop-blur-sm">
                    <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
                    <p className="text-sm text-destructive">{mediaError}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: showControls ? 1 : 0, y: showControls ? 0 : -20 }}
              transition={{ duration: 0.2 }}
              className="absolute top-0 left-0 right-0 z-20 safe-area-top"
            >
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  {getConnectionIcon()}
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      {activeCall.otherUserName}
                    </h3>
                    <p className="text-xs text-white/60">{formatDuration(callDuration)}</p>
                  </div>
                </div>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMinimized(true);
                  }}
                  className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/20 transition-colors"
                >
                  <ChevronDown className="w-5 h-5" />
                </motion.button>
              </div>
            </motion.div>

            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", damping: 20, stiffness: 200 }}
              className={cn(
                "absolute top-20 right-4 z-20",
                "w-28 h-40 md:w-36 md:h-52",
                "rounded-2xl overflow-hidden",
                "ring-2 ring-white/20 shadow-chat-lg"
              )}
            >
              <video
                ref={localVideoPipRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
              {isVideoOff && (
                <div className="absolute inset-0 bg-background-tertiary flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                    <User className="w-6 h-6 text-muted-foreground" />
                  </div>
                </div>
              )}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: showControls ? 1 : 0, y: showControls ? 0 : 40 }}
              transition={{ duration: 0.2 }}
              className="absolute bottom-0 left-0 right-0 z-20 safe-area-bottom"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 pb-8">
                <div className="flex items-center justify-center gap-4">
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={toggleAudio}
                    className={cn(
                      "w-14 h-14 rounded-full flex items-center justify-center transition-colors",
                      isMuted
                        ? "bg-destructive/20 text-destructive"
                        : "bg-white/10 backdrop-blur-md text-white hover:bg-white/20"
                    )}
                  >
                    {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={endCall}
                    className="w-16 h-16 rounded-full bg-destructive flex items-center justify-center text-white shadow-lg shadow-destructive/30"
                  >
                    <PhoneOff className="w-7 h-7" />
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={toggleVideo}
                    className={cn(
                      "w-14 h-14 rounded-full flex items-center justify-center transition-colors",
                      isVideoOff
                        ? "bg-destructive/20 text-destructive"
                        : "bg-white/10 backdrop-blur-md text-white hover:bg-white/20"
                    )}
                  >
                    {isVideoOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default VideoCallScreen;