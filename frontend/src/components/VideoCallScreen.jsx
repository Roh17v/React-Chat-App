import { useState, useEffect, useRef, useCallback, memo } from "react";
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
import CallTimer from "@/components/CallTimer";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";

const VIDEO_CONSTRAINTS = {
  width: { ideal: 640, max: 720 },
  height: { ideal: 480, max: 540 },
  frameRate: { ideal: 24, max: 30 },
};

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const MAX_VIDEO_BITRATE = 500_000;


const ConnectionIcon = memo(({ connectionStatus }) => {
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
});
ConnectionIcon.displayName = "ConnectionIcon";

const VideoCallScreen = () => {
  const { activeCall, clearActiveCall, callAccepted, clearCallAccepted, isCallMinimized, setCallMinimized } =
    useAppStore();
  const { socket } = useSocket();

  const isMinimized = isCallMinimized;
  const setIsMinimized = setCallMinimized;

  // UI STATE
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [pipExpanded, setPipExpanded] = useState(false);
  const [facingMode, setFacingMode] = useState("user");
  const [isFlipping, setIsFlipping] = useState(false);

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
  const shouldStartOnStreamReady = useRef(false);
  const acceptRetryRef = useRef(null);
  const hasReceivedOffer = useRef(false);

  // ICE candidate batching refs
  const candidateBuffer = useRef([]);
  const candidateTimer = useRef(null);

  // Wake lock ref
  const wakeLockRef = useRef(null);

  // Video refs - only 2 pairs (PiP + fullscreen), no hidden persistent elements
  const pipRemoteVideoRef = useRef(null);
  const pipLocalVideoRef = useRef(null);
  const fullscreenRemoteVideoRef = useRef(null);
  const fullscreenLocalVideoRef = useRef(null);

  // Drag Logic Refs
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

  // WebRTC stats monitoring ref
  const statsIntervalRef = useRef(null);


  // PiP sizes
  const pipSize = pipExpanded
    ? { width: 200, height: 280 }
    : { width: 120, height: 160 };

  if (!activeCall || activeCall.callType !== "video") return null;

  // Keep all 4 video elements always connected — never detach srcObject.
  // This prevents the black flicker on Capacitor Android WebView during layout switches.
  const updateVisibleLocalVideo = useCallback((stream) => {
    if (!stream) return;
    [pipLocalVideoRef.current, fullscreenLocalVideoRef.current].forEach((video) => {
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
        video.muted = true;
      }
    });
  }, []);

  const updateVisibleRemoteVideo = useCallback((stream) => {
    if (!stream) return;
    [pipRemoteVideoRef.current, fullscreenRemoteVideoRef.current].forEach((video) => {
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
      }
    });
  }, []);

  // Wake lock - keep screen on during video call
  useEffect(() => {
    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        }
      } catch (err) {
        // Wake lock may fail silently
      }
    };
    requestWakeLock();

    const handleVisibilityChange = async () => {
      if (wakeLockRef.current !== null && document.visibilityState === "visible") {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        } catch (err) {
          // Ignore
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
  }, []);

  // Background/foreground handling - disable video when app is backgrounded
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      const videoTrack = localStreamRef.current?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = isActive && !isVideoOff;
      }
    });

    return () => {
      listener.then((l) => l.remove());
    };
  }, [isVideoOff]);

  // Apply bitrate cap on the video sender
  const applyBitrateCap = useCallback(async () => {
    if (!pc.current) return;
    const sender = pc.current.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      params.encodings[0].maxFramerate = 24;
      await sender.setParameters(params);
    } catch (err) {
      // Bitrate cap is best-effort
    }
  }, []);

  // Flush batched ICE candidates
  const flushCandidates = useCallback(() => {
    if (candidateBuffer.current.length === 0) return;
    const targetId = activeCall?.otherUserId || activeCall?.callerId;
    if (!targetId) return;

    // Send batched candidates
    socket.emit("call:ice-candidates", {
      to: targetId,
      candidates: candidateBuffer.current,
    });
    candidateBuffer.current = [];
  }, [socket, activeCall?.otherUserId, activeCall?.callerId]);

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

      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacingMode, ...VIDEO_CONSTRAINTS },
        audio: false,
      });

      const newVideoTrack = videoStream.getVideoTracks()[0];
      const tracks = [newVideoTrack];
      if (oldAudioTrack) tracks.push(oldAudioTrack);

      const newStream = new MediaStream(tracks);
      localStreamRef.current = newStream;

      updateVisibleLocalVideo(newStream);

      if (pc.current) {
        const senders = pc.current.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === "video");
        if (videoSender && newVideoTrack) {
          await videoSender.replaceTrack(newVideoTrack);
          applyBitrateCap();
        }
      }

      setFacingMode(newFacingMode);
    } catch (err) {
      setMediaError("Failed to switch camera. Please try again.");
    } finally {
      setIsFlipping(false);
    }
  };

  const handleDeviceChange = async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, ...VIDEO_CONSTRAINTS },
        audio: AUDIO_CONSTRAINTS,
      });
      localStreamRef.current = newStream;

      updateVisibleLocalVideo(newStream);

      if (pc.current) {
        const senders = pc.current.getSenders();
        newStream.getTracks().forEach((newTrack) => {
          const sender = senders.find((s) => s.track?.kind === newTrack.kind);
          if (sender) sender.replaceTrack(newTrack);
        });
        applyBitrateCap();
      }
    } catch (err) {
      setMediaError("Device disconnected. Please check camera/mic.");
    }
  };

  // INITIALIZE MEDIA with constrained resolution/framerate + audio constraints
  useEffect(() => {
    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, ...VIDEO_CONSTRAINTS },
          audio: AUDIO_CONSTRAINTS,
        });
        localStreamRef.current = stream;

        updateVisibleLocalVideo(stream);

        setMediaError(null);

        stream.getTracks().forEach((track) => {
          track.onended = () => {
            handleDeviceChange();
          };
        });

        if (!activeCall.isCaller) initializePeerConnection(stream);
        if (activeCall.isCaller && shouldStartOnStreamReady.current) {
          shouldStartOnStreamReady.current = false;
          initializePeerConnection(stream);
        }
      } catch (err) {
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
    if (!activeCall?.isCaller) return;
    if (!callAccepted) return;
    setCallStatus("connected");
    if (localStreamRef.current) {
      initializePeerConnection(localStreamRef.current);
    } else {
      shouldStartOnStreamReady.current = true;
    }
    clearCallAccepted();
  }, [callAccepted, activeCall?.isCaller, clearCallAccepted]);

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
      // Use default STUN servers
    }

    pc.current = new RTCPeerConnection(config);
    stream.getTracks().forEach((track) => pc.current?.addTrack(track, stream));

    pc.current.ontrack = ({ track }) => {
      remoteStreamRef.current.addTrack(track);
      updateVisibleRemoteVideo(remoteStreamRef.current);
    };

    // Batched ICE candidates instead of sending one at a time
    pc.current.onicecandidate = ({ candidate }) => {
      if (candidate) {
        candidateBuffer.current.push(candidate);
        if (candidateTimer.current) clearTimeout(candidateTimer.current);
        candidateTimer.current = setTimeout(flushCandidates, 100);
      }
    };

    pc.current.oniceconnectionstatechange = () => {
      const state = pc.current?.iceConnectionState;
      setConnectionStatus(state);

      if (connectionTimeout.current) {
        clearTimeout(connectionTimeout.current);
        connectionTimeout.current = null;
      }

      if (state === "connected" || state === "completed") {
        applyBitrateCap();
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
        // Negotiation error
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
      if (description.type === "offer") {
        hasReceivedOffer.current = true;
        if (acceptRetryRef.current) {
          clearInterval(acceptRetryRef.current);
          acceptRetryRef.current = null;
        }
      }

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
      // Signaling error
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
          // ICE candidate error
        }
      } else {
        pendingCandidates.current.push(candidate);
      }
    };

    // Handle batched ICE candidates from the other peer
    const onCandidates = async ({ candidates }) => {
      if (!candidates || !Array.isArray(candidates)) return;
      for (const candidate of candidates) {
        if (pc.current?.remoteDescription) {
          try {
            await pc.current.addIceCandidate(candidate);
          } catch (e) {
            // ICE candidate error
          }
        } else {
          pendingCandidates.current.push(candidate);
        }
      }
    };

    const onEnd = () => cleanup();

    socket.on("call:offer", onDescription);
    socket.on("call:answer", onDescription);
    socket.on("call:ice-candidate", onCandidate);
    socket.on("call:ice-candidates", onCandidates);
    socket.on("call:end", onEnd);

    return () => {
      socket.off("call:offer", onDescription);
      socket.off("call:answer", onDescription);
      socket.off("call:ice-candidate", onCandidate);
      socket.off("call:ice-candidates", onCandidates);
      socket.off("call:end", onEnd);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket || activeCall?.isCaller) return;
    const callId = activeCall?.callId;
    const callerId = activeCall?.otherUserId || activeCall?.callerId;
    if (!callId) return;

    let attempts = 0;
    const sendAccept = () => {
      if (hasReceivedOffer.current) return;
      attempts += 1;
      socket.emit("call:accept", { callId, callerId });
      if (attempts >= 5 && acceptRetryRef.current) {
        clearInterval(acceptRetryRef.current);
        acceptRetryRef.current = null;
      }
    };

    sendAccept();
    acceptRetryRef.current = setInterval(sendAccept, 2000);

    return () => {
      if (acceptRetryRef.current) {
        clearInterval(acceptRetryRef.current);
        acceptRetryRef.current = null;
      }
    };
  }, [socket, activeCall?.isCaller, activeCall?.callId, activeCall?.otherUserId, activeCall?.callerId]);

  // WebRTC stats monitoring for adaptive quality
  useEffect(() => {
    if (connectionStatus !== "connected" && connectionStatus !== "completed") return;
    if (!pc.current) return;

    statsIntervalRef.current = setInterval(async () => {
      if (!pc.current) return;
      try {
        const stats = await pc.current.getStats();
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            if (report.qualityLimitationReason === "cpu") {
              const sender = pc.current?.getSenders().find((s) => s.track?.kind === "video");
              if (sender) {
                const params = sender.getParameters();
                if (params.encodings?.[0]) {
                  const currentBitrate = params.encodings[0].maxBitrate || MAX_VIDEO_BITRATE;
                  params.encodings[0].maxBitrate = Math.max(200_000, currentBitrate * 0.8);
                  sender.setParameters(params).catch(() => {});
                }
              }
            }
          }
        });
      } catch (e) {
        // Stats monitoring is best-effort
      }
    }, 10000);

    return () => {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
    };
  }, [connectionStatus]);

  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pc.current?.close();
    pc.current = null;
    if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
    if (animationFrameRef.current)
      cancelAnimationFrame(animationFrameRef.current);
    if (acceptRetryRef.current) {
      clearInterval(acceptRetryRef.current);
      acceptRetryRef.current = null;
    }
    if (candidateTimer.current) {
      clearTimeout(candidateTimer.current);
      candidateTimer.current = null;
    }

    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    clearActiveCall();
    clearCallAccepted();
    setConnectionStatus("disconnected");
  }, [clearActiveCall, clearCallAccepted]);

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

    // Register move/end listeners only during active drag
    const moveHandler = (ev) => {
      hasDragged.current = true;

      const cx = "clientX" in ev ? ev.clientX : ev.touches?.[0]?.clientX;
      const cy = "clientY" in ev ? ev.clientY : ev.touches?.[0]?.clientY;

      if (cx === undefined || cy === undefined) return;

      const deltaX = cx - dragStartMouse.current.x;
      const deltaY = cy - dragStartMouse.current.y;

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
    };

    const endHandler = () => {
      isDragging.current = false;
      if (pipContainerRef.current) {
        pipContainerRef.current.style.willChange = "auto";
      }
      window.removeEventListener("mousemove", moveHandler);
      window.removeEventListener("touchmove", moveHandler);
      window.removeEventListener("mouseup", endHandler);
      window.removeEventListener("touchend", endHandler);
    };

    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("touchmove", moveHandler, { passive: true });
    window.addEventListener("mouseup", endHandler);
    window.addEventListener("touchend", endHandler);
  }, [pipSize.width, pipSize.height, updatePipPosition]);

  // Debounced resize handler only
  useEffect(() => {
    let resizeTimer;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const maxX = window.innerWidth - pipSize.width - 16;
        const maxY = window.innerHeight - pipSize.height - 16;
        currentPosition.current = {
          x: Math.max(16, Math.min(currentPosition.current.x, maxX)),
          y: Math.max(16, Math.min(currentPosition.current.y, maxY)),
        };
        updatePipPosition();
      }, 150);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(resizeTimer);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [pipSize.width, pipSize.height, updatePipPosition]);

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

  const isConnecting =
    callStatus === "ringing" ||
    (connectionStatus !== "connected" && connectionStatus !== "completed");

  return (
    <>
      {/* MINIMIZED PIP VIEW */}
      <div
        ref={pipContainerRef}
        style={{
          width: pipSize.width,
          height: pipSize.height,
          left: currentPosition.current.x,
          top: currentPosition.current.y,
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

          {/* Top Bar - replaced backdrop-blur with solid bg */}
          <div className="absolute top-2 left-2 right-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60">
              <ConnectionIcon connectionStatus={connectionStatus} />
              <CallTimer connectionStatus={connectionStatus} className="text-[10px] font-medium text-white" />
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPipExpanded(!pipExpanded);
              }}
              className="w-6 h-6 rounded-full bg-black/60 flex items-center justify-center text-white/80 hover:text-white transition-colors"
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
                "absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/50",
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

      {/* FULL SCREEN VIEW - CSS transitions instead of Framer Motion */}
      <div
        style={{
          opacity: isMinimized ? 0 : 1,
          pointerEvents: isMinimized ? "none" : "auto",
          transition: "opacity 0.25s ease-out",
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

        {/* Connecting State - CSS transitions instead of Framer Motion */}
        <div
          style={{
            opacity: isConnecting ? 1 : 0,
            transition: "opacity 0.2s ease-out",
            pointerEvents: isConnecting ? "auto" : "none",
          }}
          className="absolute inset-0 flex flex-col items-center justify-center z-10"
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
        </div>

        {/* Media Error Banner - replaced backdrop-blur with solid bg */}
        <div
          style={{
            opacity: mediaError ? 1 : 0,
            transform: mediaError ? "translateY(0)" : "translateY(-20px)",
            transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
            pointerEvents: mediaError ? "auto" : "none",
          }}
          className="absolute top-4 left-4 right-4 z-30"
        >
          {mediaError && (
            <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-xl">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
              <p className="text-sm text-destructive">{mediaError}</p>
            </div>
          )}
        </div>

        {/* Top Header - CSS transitions, replaced backdrop-blur with solid bg */}
        <div
          style={{
            opacity: showControls ? 1 : 0,
            transform: showControls ? "translateY(0)" : "translateY(-20px)",
            transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
          }}
          className="absolute top-0 left-0 right-0 z-20 safe-area-top"
        >
          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <ConnectionIcon connectionStatus={connectionStatus} />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {activeCall.otherUserName}
                </h3>
                <CallTimer connectionStatus={connectionStatus} className="text-xs text-white/60" />
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsMinimized(true);
              }}
              className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center text-white hover:bg-white/25 transition-colors active:scale-90"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
          </div>
        </div>

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
          {/* Flip Camera Button on Local Video - replaced backdrop-blur */}
          {!isVideoOff && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                flipCamera();
              }}
              disabled={isFlipping}
              className={cn(
                "absolute bottom-2 right-2 w-8 h-8 rounded-full bg-black/60",
                "flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-all",
                isFlipping && "opacity-50 cursor-not-allowed",
              )}
            >
              <SwitchCamera className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Bottom Controls - CSS transitions, replaced backdrop-blur with solid bg */}
        <div
          style={{
            opacity: showControls ? 1 : 0,
            transform: showControls ? "translateY(0)" : "translateY(40px)",
            transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
          }}
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
                    : "bg-white/15 text-white hover:bg-white/25",
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
                  "bg-white/15 text-white hover:bg-white/25",
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
                    : "bg-white/15 text-white hover:bg-white/25",
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
        </div>
      </div>
    </>
  );
};

export default VideoCallScreen;
