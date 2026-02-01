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
    activeCall?.isCaller ? "ringing" : "connected",
  );
  const [connectionStatus, setConnectionStatus] = useState("initializing");
  const [mediaError, setMediaError] = useState(null);

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

  // Single set of video refs - always mounted
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);

  // Additional refs for cloned video elements to prevent flickering
  const pipRemoteVideoRef = useRef(null);
  const pipLocalVideoRef = useRef(null);
  const fullscreenRemoteVideoRef = useRef(null);
  const fullscreenLocalVideoRef = useRef(null);

  // Track if streams have been attached to prevent re-assignment
  const streamsAttached = useRef({
    hidden: { local: false, remote: false },
    pip: { local: false, remote: false },
    fullscreen: { local: false, remote: false },
  });

  // Drag Logic Refs - Using refs for smooth dragging without re-renders
  const isDragging = useRef(false);
  const hasDragged = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const currentPosition = useRef({
    x: window.innerWidth - 120 - 16,
    y: window.innerHeight - 160 - 16,
  });
  const pipContainerRef = useRef(null);
  const animationFrameRef = useRef(null);

  // PiP sizes
  const pipSize = pipExpanded
    ? { width: 200, height: 280 }
    : { width: 120, height: 160 };

  if (!activeCall || activeCall.callType !== "video") return null;

  // Helper to attach stream to video element only once
  const attachStreamToVideo = useCallback(
    (videoEl, stream, trackingKey, subKey) => {
      if (!videoEl || !stream) return;
      if (videoEl.srcObject === stream) return; // Already attached
      if (streamsAttached.current[trackingKey]?.[subKey]) return; // Already tracked as attached

      videoEl.srcObject = stream;
      if (streamsAttached.current[trackingKey]) {
        streamsAttached.current[trackingKey][subKey] = true;
      }
    },
    [],
  );

  // RESTART MEDIA ON DEVICE CHANGE
  const handleDeviceChange = async () => {
    console.log("Device change detected. Refreshing stream...");
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = newStream;

      // Reset tracking for local streams
      streamsAttached.current.hidden.local = false;
      streamsAttached.current.pip.local = false;
      streamsAttached.current.fullscreen.local = false;

      updateLocalVideoRef(newStream);

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
        updateLocalVideoRef(stream);
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
        handleDeviceChange,
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
    stream.getTracks().forEach((track) => pc.current.addTrack(track, stream));

    pc.current.ontrack = ({ track }) => {
      remoteStreamRef.current.addTrack(track);

      // Reset tracking for remote streams when new track arrives
      streamsAttached.current.hidden.remote = false;
      streamsAttached.current.pip.remote = false;
      streamsAttached.current.fullscreen.remote = false;

      // Attach to all remote video elements
      if (
        remoteVideoRef.current &&
        remoteVideoRef.current.srcObject !== remoteStreamRef.current
      ) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current
          .play()
          .catch((e) => console.log("Autoplay error", e));
      }
      if (pipRemoteVideoRef.current) {
        pipRemoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
      if (fullscreenRemoteVideoRef.current) {
        fullscreenRemoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
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
        pendingOffer.current.from,
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
    if (animationFrameRef.current)
      cancelAnimationFrame(animationFrameRef.current);
    clearActiveCall();
    setConnectionStatus("disconnected");
  }, [clearActiveCall]);

  const endCall = () => {
    const to = activeCall?.otherUserId || activeCall?.callerId;
    if (to) socket.emit("call:end", { to });
    cleanup();
  };

  const updateLocalVideoRef = (stream) => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.muted = true;
    }
    // Also update other local video refs
    if (pipLocalVideoRef.current) {
      pipLocalVideoRef.current.srcObject = stream;
    }
    if (fullscreenLocalVideoRef.current) {
      fullscreenLocalVideoRef.current.srcObject = stream;
    }
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

  // Smooth drag handlers using refs and transform
  const updatePipPosition = useCallback(() => {
    if (pipContainerRef.current) {
      pipContainerRef.current.style.left = `${currentPosition.current.x}px`;
      pipContainerRef.current.style.top = `${currentPosition.current.y}px`;
    }
  }, []);

  const handleDragStart = useCallback((e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();

    isDragging.current = true;
    hasDragged.current = false;

    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY;

    // Store the mouse start position and element start position
    dragStartMouse.current = { x: clientX, y: clientY };
    dragStartPos.current = {
      x: currentPosition.current.x,
      y: currentPosition.current.y,
    };

    if (pipContainerRef.current) {
      pipContainerRef.current.style.transition = "none";
      pipContainerRef.current.style.willChange = "left, top";
    }
  }, []);

  const handleDragMove = useCallback(
    (e) => {
      if (!isDragging.current) return;

      hasDragged.current = true;

      const clientX = e.clientX ?? e.touches?.[0]?.clientX;
      const clientY = e.clientY ?? e.touches?.[0]?.clientY;

      if (clientX === undefined || clientY === undefined) return;

      // Calculate delta from start
      const deltaX = clientX - dragStartMouse.current.x;
      const deltaY = clientY - dragStartMouse.current.y;

      // New position = start position + delta
      const newX = dragStartPos.current.x + deltaX;
      const newY = dragStartPos.current.y + deltaY;

      // Clamp to screen bounds
      const maxX = window.innerWidth - pipSize.width - 16;
      const maxY = window.innerHeight - pipSize.height - 16;

      currentPosition.current = {
        x: Math.max(16, Math.min(newX, maxX)),
        y: Math.max(16, Math.min(newY, maxY)),
      };

      // Use requestAnimationFrame for smooth updates
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = requestAnimationFrame(updatePipPosition);
    },
    [pipSize.width, pipSize.height, updatePipPosition],
  );

  const handleDragEnd = useCallback(() => {
    if (!isDragging.current) return;

    isDragging.current = false;

    if (pipContainerRef.current) {
      pipContainerRef.current.style.willChange = "auto";
    }
  }, []);

  useEffect(() => {
    const moveHandler = (e) => {
      if (isDragging.current && e.type === "touchmove") {
        e.preventDefault();
      }
      handleDragMove(e);
    };

    const handleResize = () => {
      // Keep PiP within bounds on resize
      const maxX = window.innerWidth - pipSize.width - 16;
      const maxY = window.innerHeight - pipSize.height - 16;
      currentPosition.current = {
        x: Math.max(16, Math.min(currentPosition.current.x, maxX)),
        y: Math.max(16, Math.min(currentPosition.current.y, maxY)),
      };
      updatePipPosition();
    };

    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("touchmove", moveHandler, { passive: false });
    window.addEventListener("mouseup", handleDragEnd);
    window.addEventListener("touchend", handleDragEnd);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("mousemove", moveHandler);
      window.removeEventListener("touchmove", moveHandler);
      window.removeEventListener("mouseup", handleDragEnd);
      window.removeEventListener("touchend", handleDragEnd);
      window.removeEventListener("resize", handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [
    handleDragMove,
    handleDragEnd,
    pipSize.width,
    pipSize.height,
    updatePipPosition,
  ]);

  // Reset hasDragged flag when minimized state changes
  useEffect(() => {
    hasDragged.current = false;
  }, [isMinimized]);

  // Adjust position when PiP size changes to keep it within bounds
  useEffect(() => {
    const maxX = window.innerWidth - pipSize.width - 16;
    const maxY = window.innerHeight - pipSize.height - 16;

    const needsAdjustment =
      currentPosition.current.x > maxX || currentPosition.current.y > maxY;

    if (needsAdjustment) {
      currentPosition.current = {
        x: Math.max(16, Math.min(currentPosition.current.x, maxX)),
        y: Math.max(16, Math.min(currentPosition.current.y, maxY)),
      };

      if (pipContainerRef.current) {
        pipContainerRef.current.style.transition =
          "left 0.2s ease-out, top 0.2s ease-out";
        updatePipPosition();
        // Reset transition after animation
        setTimeout(() => {
          if (pipContainerRef.current) {
            pipContainerRef.current.style.transition = "none";
          }
        }, 200);
      }
    }
  }, [pipSize.width, pipSize.height, updatePipPosition]);

  // Effect to attach streams to video elements when they mount (prevents flickering)
  useEffect(() => {
    // Attach remote stream
    if (remoteStreamRef.current.getTracks().length > 0) {
      if (
        pipRemoteVideoRef.current &&
        pipRemoteVideoRef.current.srcObject !== remoteStreamRef.current
      ) {
        pipRemoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
      if (
        fullscreenRemoteVideoRef.current &&
        fullscreenRemoteVideoRef.current.srcObject !== remoteStreamRef.current
      ) {
        fullscreenRemoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
    }

    // Attach local stream
    if (localStreamRef.current) {
      if (
        pipLocalVideoRef.current &&
        pipLocalVideoRef.current.srcObject !== localStreamRef.current
      ) {
        pipLocalVideoRef.current.srcObject = localStreamRef.current;
      }
      if (
        fullscreenLocalVideoRef.current &&
        fullscreenLocalVideoRef.current.srcObject !== localStreamRef.current
      ) {
        fullscreenLocalVideoRef.current.srcObject = localStreamRef.current;
      }
    }
  }, [isMinimized]);

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
      {/* ALWAYS MOUNTED VIDEO ELEMENTS - Hidden but connected */}
      <div
        className="fixed -top-[9999px] -left-[9999px] pointer-events-none"
        aria-hidden="true"
      >
        <video ref={remoteVideoRef} autoPlay playsInline className="w-1 h-1" />
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="w-1 h-1"
        />
      </div>

      {/* MINIMIZED PIP VIEW */}
      <AnimatePresence>
        {isMinimized && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            ref={pipContainerRef}
            style={{
              position: "fixed",
              left: currentPosition.current.x,
              top: currentPosition.current.y,
              width: pipSize.width,
              height: pipSize.height,
              zIndex: 9999,
              touchAction: "none",
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
                "active:ring-2 active:ring-primary/50",
              )}
            >
              {/* Remote Video - Using stable ref */}
              <video
                ref={pipRemoteVideoRef}
                autoPlay
                playsInline
                className="absolute inset-0 w-full h-full object-cover"
              />

              {/* Gradient Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

              {/* Top Bar */}
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

              {/* Local Video Inset - Using stable ref */}
              <motion.div
                layout
                className="absolute bottom-10 right-2 w-12 h-16 rounded-lg overflow-hidden ring-1 ring-white/20 shadow-md"
              >
                <video
                  ref={pipLocalVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                  style={{ transform: "scaleX(-1)" }}
                />
              </motion.div>

              {/* End Call Button */}
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
            {/* Remote Video Background - Constrained for large screens */}
            <div className="absolute inset-0 flex items-center justify-center bg-background-secondary">
              <video
                ref={fullscreenRemoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover md:max-w-[1920px] md:max-h-[1080px] md:object-contain"
              />

              {/* Video Off Fallback */}
              {(isConnecting || connectionStatus === "failed") && (
                <div className="absolute inset-0 bg-background-secondary" />
              )}

              {/* Gradient Overlays */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 pointer-events-none" />
            </div>

            {/* Connecting State */}
            <AnimatePresence>
              {isConnecting && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="absolute inset-0 flex flex-col items-center justify-center z-10"
                >
                  {/* Avatar with Pulse */}
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
                    {connectionStatus === "failed"
                      ? "Connection Failed"
                      : "Connecting..."}
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

            {/* Media Error Banner */}
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

            {/* Top Header */}
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{
                opacity: showControls ? 1 : 0,
                y: showControls ? 0 : -20,
              }}
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
                    <p className="text-xs text-white/60">
                      {formatDuration(callDuration)}
                    </p>
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

            {/* Local Video PiP */}
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", damping: 20, stiffness: 200 }}
              className={cn(
                "absolute top-20 right-4 z-20",
                "w-28 h-40 md:w-36 md:h-52",
                "rounded-2xl overflow-hidden",
                "ring-2 ring-white/20 shadow-chat-lg",
              )}
            >
              <video
                ref={fullscreenLocalVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
                style={{ transform: "scaleX(-1)" }}
              />
              {isVideoOff && (
                <div className="absolute inset-0 bg-background-tertiary flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                    <User className="w-6 h-6 text-muted-foreground" />
                  </div>
                </div>
              )}
            </motion.div>

            {/* Bottom Controls */}
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{
                opacity: showControls ? 1 : 0,
                y: showControls ? 0 : 40,
              }}
              transition={{ duration: 0.2 }}
              className="absolute bottom-0 left-0 right-0 z-20 safe-area-bottom"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 pb-8">
                <div className="flex items-center justify-center gap-4">
                  {/* Mute Button */}
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={toggleAudio}
                    className={cn(
                      "w-14 h-14 rounded-full flex items-center justify-center transition-colors",
                      isMuted
                        ? "bg-destructive/20 text-destructive"
                        : "bg-white/10 backdrop-blur-md text-white hover:bg-white/20",
                    )}
                  >
                    {isMuted ? (
                      <MicOff className="w-6 h-6" />
                    ) : (
                      <Mic className="w-6 h-6" />
                    )}
                  </motion.button>

                  {/* End Call Button */}
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={endCall}
                    className="w-16 h-16 rounded-full bg-destructive flex items-center justify-center text-white shadow-lg shadow-destructive/30"
                  >
                    <PhoneOff className="w-7 h-7" />
                  </motion.button>

                  {/* Video Button */}
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={toggleVideo}
                    className={cn(
                      "w-14 h-14 rounded-full flex items-center justify-center transition-colors",
                      isVideoOff
                        ? "bg-destructive/20 text-destructive"
                        : "bg-white/10 backdrop-blur-md text-white hover:bg-white/20",
                    )}
                  >
                    {isVideoOff ? (
                      <VideoOff className="w-6 h-6" />
                    ) : (
                      <Video className="w-6 h-6" />
                    )}
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
