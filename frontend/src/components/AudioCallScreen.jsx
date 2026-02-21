import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CallTimer from "@/components/CallTimer";
import {
  IoCall,
  IoMicOff,
  IoMic,
  IoVolumeHigh,
  IoVolumeMute,
  IoChevronDown,
  IoExpand,
  IoPerson,
} from "react-icons/io5";
import { Signal, SignalLow, SignalZero } from "lucide-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { GET_TURN_CREDENTIALS } from "@/utils/constants";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
// Default STUN servers (Fallback)
const DEFAULT_ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};
const AudioCallScreen = () => {
  const { activeCall, clearActiveCall, callAccepted, clearCallAccepted, isCallMinimized, setCallMinimized } =
    useAppStore();
  const { socket } = useSocket();

  // Alias store state for cleaner usage
  const isMinimized = isCallMinimized;
  const setIsMinimized = setCallMinimized;

  // UI states
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("initializing");
  // Call State
  const [callStatus, setCallStatus] = useState(
    activeCall.isCaller ? "ringing" : "connected"
  );
  const pc = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const remoteAudioRef = useRef(null);
  const connectionTimeout = useRef(null);
  const wakeLockRef = useRef(null);
  const pendingOffer = useRef(null);
  const pendingCandidates = useRef([]);
  const makingOffer = useRef(false);
  const ignoreOffer = useRef(false);
  const isPolite = useRef(!activeCall.isCaller);
  const shouldStartOnStreamReady = useRef(false);
  const acceptRetryRef = useRef(null);
  const hasReceivedOffer = useRef(false);
  if (!activeCall || activeCall.callType !== "audio") return null;
  // Wake lock screen
  useEffect(() => {
    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        }
      } catch (err) {
        console.warn("Wake Lock failed:", err);
      }
    };
    requestWakeLock();
    const handleBeforeUnload = () => {
      if (activeCall) {
        const targetId = activeCall.otherUserId || activeCall.callerId;
        socket.emit("call:end", { to: targetId });
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      if (wakeLockRef.current) wakeLockRef.current.release();
      window.removeEventListener("beforeunload", handleBeforeUnload);
      cleanup();
    };
  }, []);
  // Initialize Media
  useEffect(() => {
    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        localStreamRef.current = stream;
        stream.getAudioTracks()[0].onended = () => {
          console.warn("Mic ended unexpectedly. Restarting...");
          handleDeviceChange();
        };
        if (!activeCall.isCaller) initializePeerConnection(stream);
        if (activeCall.isCaller && shouldStartOnStreamReady.current) {
          shouldStartOnStreamReady.current = false;
          initializePeerConnection(stream);
        }
      } catch (err) {
        console.error("Media Error:", err);
        setConnectionStatus("failed");
      }
    };
    startMedia();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange
      );
    };
  }, []);
  const handleDeviceChange = async () => {
    console.log("Device change. Refreshing stream...");
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      localStreamRef.current = newStream;
      if (pc.current) {
        const senders = pc.current.getSenders();
        const sender = senders.find((s) => s.track?.kind === "audio");
        if (sender) sender.replaceTrack(newStream.getAudioTracks()[0]);
      }
    } catch (err) {
      console.error("Device switch failed", err);
    }
  };
  // Caller Trigger
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
  const initializePeerConnection = async (stream) => {
    if (pc.current) return;
    let config = { ...DEFAULT_ICE_SERVERS };
    try {
      const response = await axios.get(GET_TURN_CREDENTIALS, {
        withCredentials: true,
      });
      if (response.data.success && response.data.iceServers) {
        config.iceServers = response.data.iceServers;
      }
    } catch (error) {
      console.error("TURN Fetch Failed, using STUN:", error);
    }
    console.log("Init Audio PC");
    pc.current = new RTCPeerConnection(config);
    stream.getTracks().forEach((track) => pc.current.addTrack(track, stream));
    pc.current.ontrack = ({ track, streams }) => {
      remoteStreamRef.current = streams[0] || new MediaStream([track]);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
        remoteAudioRef.current
          .play()
          .catch((e) => console.error("Audio Play Error", e));
      }
    };
    pc.current.onicecandidate = ({ candidate }) => {
      if (candidate)
        socket.emit("call:ice-candidate", {
          to: activeCall.otherUserId || activeCall.callerId,
          candidate,
        });
    };
    pc.current.oniceconnectionstatechange = () => {
      const state = pc.current.iceConnectionState;
      setConnectionStatus(state);
      if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
      if (state === "disconnected") {
        connectionTimeout.current = setTimeout(() => {
          if (pc.current?.iceConnectionState === "disconnected") {
            console.log("Restarting ICE...");
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
      await pc.current.addIceCandidate(pendingCandidates.current.shift());
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
      console.error("Signaling Error:", err);
    }
  };
  useEffect(() => {
    if (!socket) return;
    const onDesc = ({ description, from }) =>
      handleDescription(description, from);
    const onCand = async ({ candidate }) => {
      if (pc.current?.remoteDescription) {
        try {
          await pc.current.addIceCandidate(candidate);
        } catch (e) {}
      } else {
        pendingCandidates.current.push(candidate);
      }
    };
    const onEnd = () => cleanup();
    socket.on("call:offer", onDesc);
    socket.on("call:answer", onDesc);
    socket.on("call:ice-candidate", onCand);
    socket.on("call:end", onEnd);
    return () => {
      socket.off("call:offer", onDesc);
      socket.off("call:answer", onDesc);
      socket.off("call:ice-candidate", onCand);
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
  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pc.current?.close();
    pc.current = null;
    if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
    if (acceptRetryRef.current) {
      clearInterval(acceptRetryRef.current);
      acceptRetryRef.current = null;
    }
    clearActiveCall();
    clearCallAccepted();
  }, [clearActiveCall, clearCallAccepted]);
  const endCall = () => {
    const to = activeCall?.otherUserId || activeCall?.callerId;
    if (to) socket.emit("call:end", { to });
    cleanup();
  };
  const toggleMute = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getAudioTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        setIsMuted(!track.enabled);
      }
    }
  };

  const userInitial = activeCall.otherUserName?.charAt(0).toUpperCase() || "U";
  const getConnectionIcon = () => {
    switch (connectionStatus) {
      case "connected":
      case "completed":
        return <Signal className="w-4 h-4 text-primary" />;
      case "checking":
      case "disconnected":
        return <SignalLow className="w-4 h-4 text-yellow-500" />;
      case "failed":
        return <SignalZero className="w-4 h-4 text-destructive" />;
      default:
        return <SignalLow className="w-4 h-4 text-foreground-muted animate-pulse" />;
    }
  };
  const getStatusText = () => {
    if (callStatus === "ringing") return "Ringing...";
    switch (connectionStatus) {
      case "connected":
      case "completed":
        return "Connected";
      case "checking":
        return "Connecting...";
      case "disconnected":
        return "Reconnecting...";
      case "failed":
        return "Connection Failed";
      default:
        return "Initializing...";
    }
  };
  return (
    <>
      <audio ref={remoteAudioRef} autoPlay playsInline />
      <AnimatePresence mode="wait">
        {isMinimized ? (
          <motion.div
            key="minimized"
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={() => setIsMinimized(false)}
            className="fixed top-4 right-4 z-50 flex items-center gap-3 bg-background-secondary/95 backdrop-blur-xl border border-border rounded-2xl p-2 pr-4 shadow-lg cursor-pointer hover:bg-background-tertiary transition-colors"
          >
            <div className="relative">
              <div className="absolute inset-0 bg-primary/20 rounded-full blur-md" />
              <Avatar className="h-12 w-12 ring-2 ring-primary/50">
                {activeCall.otherUserImage ? (
                  <AvatarImage src={activeCall.otherUserImage} alt="avatar" />
                ) : (
                  <AvatarFallback className="bg-primary text-primary-foreground font-semibold">
                    {userInitial}
                  </AvatarFallback>
                )}
              </Avatar>
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-primary rounded-full border-2 border-background-secondary flex items-center justify-center"
              >
                <IoCall className="w-2 h-2 text-primary-foreground" />
              </motion.div>
            </div>
            <div className="flex flex-col">
              <span className="text-foreground font-medium text-sm">
                {activeCall.otherUserName}
              </span>
              <div className="flex items-center gap-1.5">
                {getConnectionIcon()}
                <CallTimer connectionStatus={connectionStatus} className="text-primary text-xs font-medium" />
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                endCall();
              }}
              className="ml-2 w-8 h-8 rounded-full bg-destructive flex items-center justify-center text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              <IoCall className="w-4 h-4 rotate-[135deg]" />
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="fullscreen"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background"
          >
            {/* Ambient Background */}
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px]" />
              <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-primary/5 rounded-full blur-[100px]" />
            </div>
            {/* Header */}
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between p-4 safe-area-top"
            >
              <div className="flex items-center gap-2 bg-background-secondary/60 backdrop-blur-md rounded-full px-3 py-1.5">
                {getConnectionIcon()}
                <span className="text-foreground-secondary text-sm">
                  {getStatusText()}
                </span>
              </div>
              <button
                onClick={() => setIsMinimized(true)}
                className="p-3 bg-background-secondary/60 hover:bg-background-tertiary backdrop-blur-md rounded-full text-foreground transition-colors"
              >
                <IoChevronDown className="w-5 h-5" />
              </button>
            </motion.div>
            {/* Center Content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 25, delay: 0.15 }}
                className="relative mb-8"
              >
                {/* Pulsing Rings */}
                {(connectionStatus === "connected" || connectionStatus === "completed") && (
                  <>
                    <motion.div
                      animate={{ scale: [1, 1.3], opacity: [0.3, 0] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute inset-0 rounded-full border-2 border-primary"
                    />
                    <motion.div
                      animate={{ scale: [1, 1.5], opacity: [0.2, 0] }}
                      transition={{ duration: 2, repeat: Infinity, delay: 0.5 }}
                      className="absolute inset-0 rounded-full border border-primary"
                    />
                  </>
                )}
                {/* Avatar */}
                <Avatar className="h-32 w-32 sm:h-40 sm:w-40 ring-4 ring-primary/30 shadow-lg">
                  {activeCall.otherUserImage ? (
                    <AvatarImage
                      src={activeCall.otherUserImage}
                      alt="avatar"
                      className="object-cover"
                    />
                  ) : (
                    <AvatarFallback className="bg-primary text-primary-foreground text-5xl sm:text-6xl font-bold">
                      {userInitial}
                    </AvatarFallback>
                  )}
                </Avatar>
                {/* Call Icon Badge */}
                <motion.div
                  animate={
                    connectionStatus === "connected" || connectionStatus === "completed"
                      ? { scale: [1, 1.1, 1] }
                      : { rotate: [0, 10, -10, 0] }
                  }
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-10 h-10 bg-primary rounded-full flex items-center justify-center shadow-lg"
                >
                  <IoCall className="w-5 h-5 text-primary-foreground" />
                </motion.div>
              </motion.div>
              {/* Name & Duration */}
              <motion.h2
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-foreground text-2xl sm:text-3xl font-semibold mb-2"
              >
                {activeCall.otherUserName}
              </motion.h2>
                <CallTimer connectionStatus={connectionStatus} className="text-primary text-lg font-medium" />
            </div>
            {/* Control Bar */}
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30, delay: 0.3 }}
              className="absolute bottom-8 left-0 right-0 flex justify-center safe-area-bottom"
            >
              <div className="flex items-center gap-4 bg-background-secondary/80 backdrop-blur-xl rounded-full px-6 py-4 border border-border shadow-lg">
                {/* Mute */}
                <button
                  onClick={toggleMute}
                  className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 ${
                    isMuted
                      ? "bg-destructive/20 text-destructive"
                      : "bg-accent hover:bg-accent/80 text-foreground"
                  }`}
                >
                  {isMuted ? (
                    <IoMicOff className="w-6 h-6" />
                  ) : (
                    <IoMic className="w-6 h-6" />
                  )}
                </button>
                {/* End Call */}
                <button
                  onClick={endCall}
                  className="w-16 h-16 rounded-full bg-destructive hover:bg-destructive/90 flex items-center justify-center text-destructive-foreground transition-all duration-200 shadow-lg hover:shadow-destructive/30"
                >
                  <IoCall className="w-7 h-7 rotate-[135deg]" />
                </button>
                {/* Speaker */}
                <button
                  onClick={() => setIsSpeakerOn(!isSpeakerOn)}
                  className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 ${
                    !isSpeakerOn
                      ? "bg-foreground text-background"
                      : "bg-accent hover:bg-accent/80 text-foreground"
                  }`}
                >
                  {isSpeakerOn ? (
                    <IoVolumeHigh className="w-6 h-6" />
                  ) : (
                    <IoVolumeMute className="w-6 h-6" />
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
export default AudioCallScreen;
