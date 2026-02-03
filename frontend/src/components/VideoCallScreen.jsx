import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
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
  SwitchCamera,
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
  const [facingMode, setFacingMode] = useState("user");
  const [isFlipping, setIsFlipping] = useState(false);
  
  // Track when streams are ready to trigger video element updates
  const [localStreamReady, setLocalStreamReady] = useState(false);
  const [remoteStreamReady, setRemoteStreamReady] = useState(false);

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

  // SINGLE SET OF PERSISTENT VIDEO REFS - Never remounted
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  
  // Display video refs for PiP and fullscreen
  const pipRemoteVideoRef = useRef(null);
  const pipLocalVideoRef = useRef(null);
  const fullscreenRemoteVideoRef = useRef(null);
  const fullscreenLocalVideoRef = useRef(null);

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

  // Helper to update all local video elements
  const updateAllLocalVideos = useCallback((stream) => {
    if (!stream) return;
    
    const videos = [
      localVideoRef.current,
      pipLocalVideoRef.current,
      fullscreenLocalVideoRef.current,
    ];
    
    videos.forEach((video) => {
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
        video.muted = true;
      }
    });
  }, []);

  // Helper to update all remote video elements
  const updateAllRemoteVideos = useCallback((stream) => {
    if (!stream) return;
    
    const videos = [
      remoteVideoRef.current,
      pipRemoteVideoRef.current,
      fullscreenRemoteVideoRef.current,
    ];
    
    videos.forEach((video) => {
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
      }
    });
  }, []);

  // Effect to sync local stream to all video elements when ready
  useEffect(() => {
    if (localStreamReady && localStreamRef.current) {
      updateAllLocalVideos(localStreamRef.current);
    }
  }, [localStreamReady, updateAllLocalVideos, isMinimized]);

  // Effect to sync remote stream to all video elements when ready
  useEffect(() => {
    if (remoteStreamReady && remoteStreamRef.current) {
      updateAllRemoteVideos(remoteStreamRef.current);
    }
  }, [remoteStreamReady, updateAllRemoteVideos, isMinimized]);

  const flipCamera = async () => {
    if (isFlipping || isVideoOff) return;
    setIsFlipping(true);

    try {
      const newFacingMode = facingMode === "user" ? "environment" : "user";
      const currentStream = localStreamRef.current;
      const oldAudioTrack = currentStream?.getAudioTracks()[0];
      const oldVideoTrack = currentStream?.getVideoTracks()[0];

      if (oldVideoTrack) {
        oldVideoTrack.stop();
      }

      await new Promise((resolve) => setTimeout(resolve, 200));

      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacingMode },
        audio: false,
      });

      const newVideoTrack = videoStream.getVideoTracks()[0];
      const tracks = [newVideoTrack];
      if (oldAudioTrack) tracks.push(oldAudioTrack);

      const newStream = new MediaStream(tracks);
      localStreamRef.current = newStream;

      // Update all local video elements
      updateAllLocalVideos(newStream);

      if (pc.current) {
        const senders = pc.current.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === "video");
        if (videoSender && newVideoTrack) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }

      setFacingMode(newFacingMode);
    } catch (err) {
      console.error("Failed to flip camera:", err);
      setMediaError("Failed to switch camera. Please try again.");
    } finally {
      setIsFlipping(false);
    }
  };

  const handleDeviceChange = async () => {
    console.log("Device change detected. Refreshing stream...");
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: true,
      });
      localStreamRef.current = newStream;

      // Update all local video elements
      updateAllLocalVideos(newStream);

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
          video: { facingMode },
          audio: true,
        });
        localStreamRef.current = stream;

        // Update all local video elements
        updateAllLocalVideos(stream);
        
        // Mark local stream as ready
        setLocalStreamReady(true);

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
    stream.getTracks().forEach((track) => pc.current?.addTrack(track, stream));

    pc.current.ontrack = ({ track }) => {
      remoteStreamRef.current.addTrack(track);

      // Update all remote video elements
      updateAllRemoteVideos(remoteStreamRef.current);
      
      // Mark remote stream as ready
      setRemoteStreamReady(true);
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
      const state = pc.current?.iceConnectionState;
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
        pc.current?.restartIce();
      }
    };

    pc.current.onnegotiationneeded = async () => {
      try {
        makingOffer.current = true;
        await pc.current?.setLocalDescription();
        socket.emit("call:offer", {
          to: activeCall.otherUserId || activeCall.callerId,
          description: pc.current?.localDescription,
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
      if (candidate) await pc.current.addIceCandidate(candidate);
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

  // Smooth drag handlers
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

    const clientX = "clientX" in e ? e.clientX : e.touches?.[0]?.clientX;
    const clientY = "clientY" in e ? e.clientY : e.touches?.[0]?.clientY;

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

      const clientX = "clientX" in e ? e.clientX : e.touches?.[0]?.clientX;
      const clientY = "clientY" in e ? e.clientY : e.touches?.[0]?.clientY;

      if (clientX === undefined || clientY === undefined) return;

      const deltaX = clientX - dragStartMouse.current.x;
      const deltaY = clientY - dragStartMouse.current.y;

      const newX = dragStartPos.current.x + deltaX;
      const newY = dragStartPos.current.y + deltaY;

      const maxX = window.innerWidth - pipSize.width - 16;
      const maxY = window.innerHeight - pipSize.height - 16;

      currentPosition.current = {
        x: Math.max(16, Math.min(newX, maxX)),
        y: Math.max(16, Math.min(newY, maxY)),
      };

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

  useEffect(() => {
    hasDragged.current = false;
  }, [isMinimized]);

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
        setTimeout(() => {
          if (pipContainerRef.current) {
            pipContainerRef.current.style.transition = "none";
          }
        }, 200);
      }
    }
  }, [pipSize.width, pipSize.height, updatePipPosition]);

  const getConnectionIcon = () => {
    switch (connectionStatus) {
      case "connected":
      case "completed":
        return <Signal className="w-3.5 h-3.5 text-status-online" />;
      case "checking":
      case "new":
        return (
          <SignalLow className="w-3.5 h-3.5 text-yellow-400 animate-pulse" />
        );
      default:
        return <SignalZero className="w-3.5 h-3.5 text-destructive" />;
    }
  };

  const isConnecting =
    callStatus === "ringing" ||
    (connectionStatus !== "connected" && connectionStatus !== "completed");

  return (
    <>
      {/* PERSISTENT HIDDEN VIDEO ELEMENTS - Source of truth, never remounted */}
      <div
        className="fixed pointer-events-none"
        style={{ opacity: 0, position: "fixed", top: -9999, left: -9999 }}
        aria-hidden="true"
      >
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="w-1 h-1"
        />
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="w-1 h-1"
        />
      </div>

      {/* MINIMIZED PIP VIEW - Always rendered, visibility controlled by CSS */}
      <div
        ref={pipContainerRef}
        style={{
          width: pipSize.width,
          height: pipSize.height,
          left: currentPosition.current.x,
          top: currentPosition.current.y,
          visibility: isMinimized ? "visible" : "hidden",
          opacity: isMinimized ? 1 : 0,
          transform: isMinimized ? "scale(1)" : "scale(0.8)",
          transition:
            "opacity 0.25s ease-out, transform 0.25s ease-out, width 0.2s ease-out, height 0.2s ease-out",
          pointerEvents: isMinimized ? "auto" : "none",
        }}
        className="fixed z-[9999] select-none touch-none"
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
      >
        <div
          onClick={() => !hasDragged.current && setIsMinimized(false)}
          className={cn(
            "relative w-full h-full rounded-2xl overflow-hidden",
            "bg-background-secondary ring-1 ring-border",
            "shadow-chat-lg cursor-move",
            "active:ring-2 active:ring-primary/50",
          )}
        >
          {/* Remote Video */}
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

          {/* Local Video Inset */}
          <div className="absolute bottom-10 right-2 w-12 h-16 rounded-lg overflow-hidden ring-1 ring-white/20 shadow-md">
            <video
              ref={pipLocalVideoRef}
              autoPlay
              playsInline
              muted
              className={cn(
                "w-full h-full object-cover",
                facingMode === "user" && "-scale-x-100",
              )}
            />
            {/* Flip Camera Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                flipCamera();
              }}
              disabled={isFlipping || isVideoOff}
              className={cn(
                "absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/50 backdrop-blur-sm",
                "flex items-center justify-center text-white/80 hover:text-white transition-all",
                (isFlipping || isVideoOff) && "opacity-50 cursor-not-allowed",
              )}
            >
              <SwitchCamera className="w-3 h-3" />
            </button>
          </div>

          {/* End Call Button */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-center">
            <button
              onClick={(e) => {
                e.stopPropagation();
                endCall();
              }}
              className="w-8 h-8 rounded-full bg-destructive flex items-center justify-center text-white shadow-lg active:scale-90 transition-transform"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* FULL SCREEN VIEW - Always rendered, visibility controlled by CSS */}
      <motion.div
        initial={false}
        animate={{
          opacity: isMinimized ? 0 : 1,
        }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        style={{
          visibility: isMinimized ? "hidden" : "visible",
          pointerEvents: isMinimized ? "none" : "auto",
        }}
        className="fixed inset-0 z-50 bg-background"
        onClick={() => setShowControls((p) => !p)}
      >
        {/* Remote Video Background */}
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
        <motion.div
          initial={false}
          animate={{ opacity: isConnecting ? 1 : 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 flex flex-col items-center justify-center z-10"
          style={{ pointerEvents: isConnecting ? "auto" : "none" }}
        >
          {isConnecting && (
            <div className="flex flex-col items-center gap-6">
              {/* Avatar with Pulse */}
              <div className="relative mb-6">
                <div
                  className="absolute inset-0 rounded-full bg-primary/30 animate-ping"
                  style={{ margin: "-12px" }}
                />
                <div
                  className="absolute inset-0 rounded-full bg-primary/20 animate-pulse"
                  style={{ margin: "-24px", transform: "scale(1.1)" }}
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

              <p className="text-sm text-foreground-secondary animate-pulse">
                {connectionStatus === "failed"
                  ? "Connection Failed"
                  : "Connecting..."}
              </p>

              {connectionStatus === "failed" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    pc.current?.restartIce();
                  }}
                  className="mt-6 px-5 py-2.5 bg-primary/10 border border-primary/30 rounded-full text-primary font-medium flex items-center gap-2 hover:bg-primary/20 transition-colors active:scale-95"
                >
                  <RefreshCw className="w-4 h-4" />
                  Retry Connection
                </button>
              )}
            </div>
          )}
        </motion.div>

        {/* Media Error Banner */}
        <motion.div
          initial={false}
          animate={{ opacity: mediaError ? 1 : 0, y: mediaError ? 0 : -20 }}
          transition={{ duration: 0.2 }}
          className="absolute top-4 left-4 right-4 z-30"
          style={{ pointerEvents: mediaError ? "auto" : "none" }}
        >
          {mediaError && (
            <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-xl backdrop-blur-sm">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
              <p className="text-sm text-destructive">{mediaError}</p>
            </div>
          )}
        </motion.div>

        {/* Top Header */}
        <motion.div
          initial={false}
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
                <p className="text-xs text-white/60">
                  {formatDuration(callDuration)}
                </p>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsMinimized(true);
              }}
              className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/20 transition-colors active:scale-90"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
          </div>
        </motion.div>

        {/* Local Video PiP */}
        <div
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
            className={cn(
              "w-full h-full object-cover",
              facingMode === "user" && "-scale-x-100",
            )}
          />
          {isVideoOff && (
            <div className="absolute inset-0 bg-background-tertiary flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <User className="w-6 h-6 text-muted-foreground" />
              </div>
            </div>
          )}
          {/* Flip Camera Button on Local Video */}
          {!isVideoOff && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                flipCamera();
              }}
              disabled={isFlipping}
              className={cn(
                "absolute bottom-2 right-2 w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm",
                "flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-all",
                isFlipping && "opacity-50 cursor-not-allowed",
              )}
            >
              <SwitchCamera className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Bottom Controls */}
        <motion.div
          initial={false}
          animate={{ opacity: showControls ? 1 : 0, y: showControls ? 0 : 40 }}
          transition={{ duration: 0.2 }}
          className="absolute bottom-0 left-0 right-0 z-20 safe-area-bottom"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-6 pb-8">
            <div className="flex items-center justify-center gap-4">
              {/* Mute Button */}
              <button
                onClick={toggleAudio}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-colors active:scale-90",
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
              </button>

              {/* Flip Camera Button */}
              <button
                onClick={flipCamera}
                disabled={isFlipping || isVideoOff}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-colors active:scale-90",
                  "bg-white/10 backdrop-blur-md text-white hover:bg-white/20",
                  (isFlipping || isVideoOff) && "opacity-50 cursor-not-allowed",
                )}
              >
                <SwitchCamera className="w-6 h-6" />
              </button>

              {/* End Call Button */}
              <button
                onClick={endCall}
                className="w-16 h-16 rounded-full bg-destructive flex items-center justify-center text-white shadow-lg shadow-destructive/30 active:scale-90 transition-transform"
              >
                <PhoneOff className="w-7 h-7" />
              </button>

              {/* Video Button */}
              <button
                onClick={toggleVideo}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-colors active:scale-90",
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
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </>
  );
};

export default VideoCallScreen;
