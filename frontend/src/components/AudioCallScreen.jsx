import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CallTimer from "@/components/CallTimer";
import {
  IoCall,
  IoMicOff,
  IoMic,
  IoVolumeHigh,
  IoChevronDown,
} from "react-icons/io5";
import { Signal, SignalLow, SignalZero } from "lucide-react";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { GET_TURN_CREDENTIALS } from "@/utils/constants";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Capacitor } from "@capacitor/core";
import NativeCallPlugin from "@/plugins/NativeCallPlugin";

const DEFAULT_ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const MAX_ICE_RESTART_ATTEMPTS = 3;

const AudioCallScreen = () => {
  const {
    activeCall,
    clearActiveCall,
    callAccepted,
    clearCallAccepted,
    isCallMinimized,
    setCallMinimized,
  } = useAppStore();
  const { socket } = useSocket();
  const isNativePlatform = Capacitor.isNativePlatform();
  const isAudioCallActive = Boolean(activeCall && activeCall.callType === "audio");

  const isMinimized = isCallMinimized;
  const setIsMinimized = setCallMinimized;

  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(!isNativePlatform);
  const [connectionStatus, setConnectionStatus] = useState("initializing");
  const [callStatus, setCallStatus] = useState(
    activeCall?.isCaller ? "ringing" : "connecting",
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
  const isPolite = useRef(!activeCall?.isCaller);
  const shouldStartOnStreamReady = useRef(false);
  const acceptRetryRef = useRef(null);
  const hasReceivedOffer = useRef(false);
  const candidateBuffer = useRef([]);
  const candidateTimer = useRef(null);
  const iceRestartAttemptsRef = useRef(0);
  const cleanedUpRef = useRef(false);
  const reconnectIntervalRef = useRef(null);
  const offerKickstartTimeoutRef = useRef(null);
  const offerRetryIntervalRef = useRef(null);
  const offerRetryAttemptsRef = useRef(0);
  const localOfferSentRef = useRef(false);
  const lastOfferSentAtRef = useRef(0);
  const hasReceivedAnswerRef = useRef(false);
  const nativeAudioRoutingPreparedRef = useRef(false);

  const getTargetId = useCallback(
    () => activeCall?.otherUserId || activeCall?.callerId,
    [activeCall?.otherUserId, activeCall?.callerId],
  );

  useEffect(() => {
    if (!isAudioCallActive) return;
    cleanedUpRef.current = false;
    isPolite.current = !activeCall?.isCaller;
    setConnectionStatus("initializing");
    setCallStatus(activeCall?.isCaller ? "ringing" : "connecting");
  }, [activeCall?.callId, activeCall?.isCaller, isAudioCallActive]);

  const clearConnectionTimeout = useCallback(() => {
    if (connectionTimeout.current) {
      clearTimeout(connectionTimeout.current);
      connectionTimeout.current = null;
    }
  }, []);

  const clearAcceptRetry = useCallback(() => {
    if (acceptRetryRef.current) {
      clearInterval(acceptRetryRef.current);
      acceptRetryRef.current = null;
    }
  }, []);

  const clearCandidateTimer = useCallback(() => {
    if (candidateTimer.current) {
      clearTimeout(candidateTimer.current);
      candidateTimer.current = null;
    }
  }, []);

  const clearOfferKickstartTimeout = useCallback(() => {
    if (offerKickstartTimeoutRef.current) {
      clearTimeout(offerKickstartTimeoutRef.current);
      offerKickstartTimeoutRef.current = null;
    }
  }, []);

  const clearOfferRetryInterval = useCallback(() => {
    if (offerRetryIntervalRef.current) {
      clearInterval(offerRetryIntervalRef.current);
      offerRetryIntervalRef.current = null;
    }
    offerRetryAttemptsRef.current = 0;
  }, []);

  const clearReconnectInterval = useCallback(() => {
    if (reconnectIntervalRef.current) {
      clearInterval(reconnectIntervalRef.current);
      reconnectIntervalRef.current = null;
    }
  }, []);

  const applySpeakerState = useCallback(() => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl) return;
    if (isNativePlatform) {
      audioEl.muted = false;
      audioEl.volume = 1;
      audioEl.play().catch(() => {});
      return;
    }

    audioEl.muted = !isSpeakerOn;
    audioEl.volume = isSpeakerOn ? 1 : 0;
    if (isSpeakerOn) {
      audioEl.play().catch(() => {});
    }
  }, [isNativePlatform, isSpeakerOn]);

  const tryRestartIce = useCallback(() => {
    const peer = pc.current;
    if (!peer || peer.signalingState === "closed") return false;

    if (iceRestartAttemptsRef.current >= MAX_ICE_RESTART_ATTEMPTS) {
      setConnectionStatus("failed");
      return false;
    }

    iceRestartAttemptsRef.current += 1;
    try {
      peer.restartIce();
      return true;
    } catch {
      setConnectionStatus("failed");
      return false;
    }
  }, []);

  const flushCandidates = useCallback(() => {
    if (!socket || candidateBuffer.current.length === 0) return;
    const to = getTargetId();
    if (!to) {
      candidateBuffer.current = [];
      return;
    }
    socket.emit("call:ice-candidates", {
      to,
      candidates: [...candidateBuffer.current],
    });
    candidateBuffer.current = [];
  }, [socket, getTargetId]);

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

    clearConnectionTimeout();
    clearAcceptRetry();
    clearCandidateTimer();
    clearReconnectInterval();
    clearOfferKickstartTimeout();
    clearOfferRetryInterval();

    candidateBuffer.current = [];
    pendingCandidates.current = [];
    pendingOffer.current = null;
    shouldStartOnStreamReady.current = false;
    hasReceivedOffer.current = false;
    hasReceivedAnswerRef.current = false;
    localOfferSentRef.current = false;
    lastOfferSentAtRef.current = 0;
    makingOffer.current = false;
    ignoreOffer.current = false;
    iceRestartAttemptsRef.current = 0;

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = new MediaStream();

    if (pc.current) {
      pc.current.onicecandidate = null;
      pc.current.oniceconnectionstatechange = null;
      pc.current.onconnectionstatechange = null;
      pc.current.onnegotiationneeded = null;
      pc.current.ontrack = null;
      pc.current.close();
      pc.current = null;
    }

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }

    if (isNativePlatform && nativeAudioRoutingPreparedRef.current) {
      NativeCallPlugin.teardownAudioRouting().catch(() => {});
      nativeAudioRoutingPreparedRef.current = false;
    }

    setConnectionStatus("disconnected");
    setCallStatus("connecting");
    setIsMuted(false);
    setIsSpeakerOn(!isNativePlatform);
    setCallMinimized(false);
    clearActiveCall();
    clearCallAccepted();
  }, [
    clearAcceptRetry,
    clearCallAccepted,
    clearCandidateTimer,
    clearConnectionTimeout,
    clearOfferKickstartTimeout,
    clearOfferRetryInterval,
    clearReconnectInterval,
    clearActiveCall,
    isNativePlatform,
    setCallMinimized,
  ]);

  const handleDeviceChange = useCallback(async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
      });

      const oldTrack = localStreamRef.current?.getAudioTracks?.()[0];
      const nextTrack = newStream.getAudioTracks()[0];
      if (oldTrack) oldTrack.stop();

      localStreamRef.current = newStream;
      if (pc.current && nextTrack) {
        const sender = pc.current
          .getSenders()
          .find((currentSender) => currentSender.track?.kind === "audio");
        if (sender) {
          sender.replaceTrack(nextTrack);
        }
        nextTrack.enabled = !isMuted;
      }
    } catch {
      setConnectionStatus("failed");
    }
  }, [isMuted]);

  const handleDescription = useCallback(
    async (description, from) => {
      const peer = pc.current;
      if (!peer) {
        pendingOffer.current = { description, from };
        return;
      }
      if (!description?.type) return;

      try {
        if (
          description.type === "answer" &&
          peer.signalingState !== "have-local-offer"
        ) {
          return;
        }

        const offerCollision =
          description.type === "offer" &&
          (makingOffer.current || peer.signalingState !== "stable");
        ignoreOffer.current = !isPolite.current && offerCollision;
        if (ignoreOffer.current) return;

        if (description.type === "offer") {
          hasReceivedOffer.current = true;
          localOfferSentRef.current = false;
          clearAcceptRetry();
          clearOfferRetryInterval();
        } else if (description.type === "answer") {
          hasReceivedAnswerRef.current = true;
          clearOfferRetryInterval();
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

        while (pendingCandidates.current.length > 0) {
          const queuedCandidate = pendingCandidates.current.shift();
          if (!queuedCandidate) continue;
          try {
            await peer.addIceCandidate(queuedCandidate);
          } catch {
            // best effort
          }
        }
      } catch (err) {
        const msg = String(err?.message || "").toLowerCase();
        const isStaleSignal =
          msg.includes("state") ||
          msg.includes("wrong state") ||
          msg.includes("rollback");
        if (!isStaleSignal) {
          setConnectionStatus("failed");
        }
      }
    },
    [socket, clearAcceptRetry, clearOfferRetryInterval],
  );

  const sendLocalOffer = useCallback(
    async (force = false) => {
      const peer = pc.current;
      if (!peer) return;
      const to = getTargetId();
      if (!to) return;
      if (makingOffer.current) return;

      if (peer.signalingState === "have-local-offer" && force) {
        if (peer.localDescription?.type === "offer") {
          socket.emit("call:offer", {
            to,
            description: peer.localDescription,
          });
          localOfferSentRef.current = true;
          lastOfferSentAtRef.current = Date.now();
        }
        return;
      }

      if (peer.signalingState !== "stable") return;

      if (
        !force &&
        localOfferSentRef.current &&
        !hasReceivedAnswerRef.current &&
        Date.now() - lastOfferSentAtRef.current < 1200
      ) {
        return;
      }

      try {
        makingOffer.current = true;
        await peer.setLocalDescription();
        socket.emit("call:offer", {
          to,
          description: peer.localDescription,
        });
        localOfferSentRef.current = true;
        lastOfferSentAtRef.current = Date.now();
      } catch {
        setConnectionStatus("failed");
      } finally {
        makingOffer.current = false;
      }
    },
    [getTargetId, socket],
  );

  const startReconnectInterval = useCallback(() => {
    if (reconnectIntervalRef.current) return;

    reconnectIntervalRef.current = setInterval(() => {
      const peer = pc.current;
      if (!peer || peer.signalingState === "closed") {
        clearReconnectInterval();
        return;
      }

      const state = peer.iceConnectionState;
      if (state === "connected" || state === "completed" || state === "closed") {
        clearReconnectInterval();
        return;
      }

      const restarted = tryRestartIce();
      if (!restarted) {
        clearReconnectInterval();
        return;
      }

      sendLocalOffer(true);
    }, 2200);
  }, [clearReconnectInterval, sendLocalOffer, tryRestartIce]);

  const initializePeerConnection = useCallback(
    async (stream) => {
      if (pc.current) return;

      let config = { ...DEFAULT_ICE_SERVERS };
      try {
        const response = await axios.get(GET_TURN_CREDENTIALS, {
          withCredentials: true,
        });
        if (response.data.success && response.data.iceServers) {
          config.iceServers = response.data.iceServers;
        }
      } catch {
        // default STUN fallback
      }

      const peer = new RTCPeerConnection(config);
      pc.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.ontrack = ({ track, streams }) => {
        remoteStreamRef.current = streams[0] || new MediaStream([track]);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStreamRef.current;
          applySpeakerState();
        }
      };

      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          flushCandidates();
          return;
        }
        candidateBuffer.current.push(candidate);
        clearCandidateTimer();
        candidateTimer.current = setTimeout(flushCandidates, 100);
      };

      peer.oniceconnectionstatechange = () => {
        const state = peer.iceConnectionState;
        setConnectionStatus(state);

        if (state === "connected" || state === "completed") {
          setCallStatus("connected");
          iceRestartAttemptsRef.current = 0;
          clearReconnectInterval();
          hasReceivedAnswerRef.current = true;
          clearOfferRetryInterval();
          clearConnectionTimeout();
          return;
        }

        if (state === "disconnected") {
          setCallStatus("connecting");
          startReconnectInterval();
          return;
        }

        if (state === "failed") {
          setCallStatus("connecting");
          startReconnectInterval();
        }
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setCallStatus("connected");
          clearReconnectInterval();
        } else if (
          peer.connectionState === "failed" &&
          iceRestartAttemptsRef.current >= MAX_ICE_RESTART_ATTEMPTS
        ) {
          clearReconnectInterval();
          setConnectionStatus("failed");
        }
      };

      peer.onnegotiationneeded = async () => {
        await sendLocalOffer();
      };

      if (pendingOffer.current) {
        await handleDescription(
          pendingOffer.current.description,
          pendingOffer.current.from,
        );
        pendingOffer.current = null;
      }

      while (pendingCandidates.current.length > 0) {
        const queuedCandidate = pendingCandidates.current.shift();
        if (queuedCandidate) {
          await peer.addIceCandidate(queuedCandidate);
        }
      }

      // Same stabilization strategy as native call flow: if negotiationneeded
      // gets delayed/missed on caller side, proactively kickstart an offer.
      if (activeCall?.isCaller) {
        clearOfferKickstartTimeout();
        clearOfferRetryInterval();
        offerKickstartTimeoutRef.current = setTimeout(() => {
          if (
            hasReceivedAnswerRef.current ||
            hasReceivedOffer.current ||
            pc.current?.connectionState === "connected" ||
            pc.current?.iceConnectionState === "connected" ||
            pc.current?.iceConnectionState === "completed"
          ) {
            return;
          }
          sendLocalOffer(true);
          offerRetryIntervalRef.current = setInterval(() => {
            if (
              hasReceivedAnswerRef.current ||
              hasReceivedOffer.current ||
              pc.current?.connectionState === "connected" ||
              pc.current?.iceConnectionState === "connected" ||
              pc.current?.iceConnectionState === "completed"
            ) {
              clearOfferRetryInterval();
              return;
            }
            offerRetryAttemptsRef.current += 1;
            sendLocalOffer(true);
            if (offerRetryAttemptsRef.current >= 6) {
              clearOfferRetryInterval();
            }
          }, 900);
        }, 250);
      }

      clearConnectionTimeout();
      connectionTimeout.current = setTimeout(() => {
        const state = pc.current?.iceConnectionState;
        if (!state) return;
        if (state === "connected" || state === "completed") return;
        setCallStatus("connecting");
        startReconnectInterval();
      }, 9000);
    },
    [
      activeCall?.isCaller,
      applySpeakerState,
      clearCandidateTimer,
      clearConnectionTimeout,
      clearReconnectInterval,
      clearOfferKickstartTimeout,
      clearOfferRetryInterval,
      flushCandidates,
      handleDescription,
      sendLocalOffer,
      startReconnectInterval,
    ],
  );

  useEffect(() => {
    if (!isAudioCallActive) return;
    applySpeakerState();
  }, [applySpeakerState, isAudioCallActive]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    const enabled = !isMuted;
    localStreamRef.current?.getAudioTracks?.().forEach((track) => {
      track.enabled = enabled;
    });
    pc.current
      ?.getSenders()
      ?.filter((sender) => sender.track?.kind === "audio")
      .forEach((sender) => {
        if (sender.track) sender.track.enabled = enabled;
      });
  }, [isMuted, isAudioCallActive]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    if (!isNativePlatform) return;
    let isCancelled = false;

    const prepareNativeAudioRoute = async () => {
      try {
        const res = await NativeCallPlugin.setupAudioRouting({
          defaultRoute: "earpiece",
        });
        if (isCancelled) return;
        nativeAudioRoutingPreparedRef.current = true;
        if (typeof res?.speakerOn === "boolean") {
          setIsSpeakerOn(Boolean(res.speakerOn));
        } else {
          setIsSpeakerOn(false);
        }
      } catch {
        nativeAudioRoutingPreparedRef.current = false;
      }
    };

    prepareNativeAudioRoute();

    return () => {
      isCancelled = true;
      if (nativeAudioRoutingPreparedRef.current) {
        NativeCallPlugin.teardownAudioRouting().catch(() => {});
        nativeAudioRoutingPreparedRef.current = false;
      }
    };
  }, [isAudioCallActive, isNativePlatform]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator && !wakeLockRef.current) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        }
      } catch {
        // best effort
      }
    };

    requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [isAudioCallActive]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    const handleBeforeUnload = () => {
      const targetId = getTargetId();
      if (targetId) socket?.emit("call:end", { to: targetId });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [getTargetId, isAudioCallActive, socket]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
        });
        localStreamRef.current = stream;

        const micTrack = stream.getAudioTracks()[0];
        if (micTrack) {
          micTrack.enabled = true;
          micTrack.onended = () => {
            handleDeviceChange();
          };
        }

        if (!activeCall?.isCaller) {
          await initializePeerConnection(stream);
        }

        if (activeCall?.isCaller && shouldStartOnStreamReady.current) {
          shouldStartOnStreamReady.current = false;
          await initializePeerConnection(stream);
        }
      } catch {
        setConnectionStatus("failed");
        const targetId = getTargetId();
        if (targetId) {
          socket?.emit("call:end", { to: targetId, reason: "audio_permission_denied" });
        }
        cleanup();
      }
    };

    startMedia();

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    }

    return () => {
      if (navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
      }
    };
  }, [
    activeCall?.isCaller,
    cleanup,
    getTargetId,
    handleDeviceChange,
    initializePeerConnection,
    isAudioCallActive,
    socket,
  ]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    if (!activeCall?.isCaller) return;
    if (!callAccepted) return;

    setCallStatus("connected");
    if (localStreamRef.current) {
      initializePeerConnection(localStreamRef.current);
    } else {
      shouldStartOnStreamReady.current = true;
    }
    clearCallAccepted();
  }, [
    callAccepted,
    activeCall?.isCaller,
    clearCallAccepted,
    initializePeerConnection,
    isAudioCallActive,
  ]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    if (!socket) return;

    const onDesc = ({ description, from }) => handleDescription(description, from);

    const addCandidate = async (candidate) => {
      if (!candidate) return;
      if (pc.current?.remoteDescription) {
        try {
          await pc.current.addIceCandidate(candidate);
        } catch {
          // best effort
        }
      } else {
        pendingCandidates.current.push(candidate);
      }
    };

    const onCandidate = async ({ candidate }) => {
      await addCandidate(candidate);
    };

    const onCandidates = async ({ candidates }) => {
      if (!Array.isArray(candidates)) return;
      for (const candidate of candidates) {
        await addCandidate(candidate);
      }
    };

    const onEnd = () => cleanup();

    socket.on("call:offer", onDesc);
    socket.on("call:answer", onDesc);
    socket.on("call:ice-candidate", onCandidate);
    socket.on("call:ice-candidates", onCandidates);
    socket.on("call:end", onEnd);

    return () => {
      socket.off("call:offer", onDesc);
      socket.off("call:answer", onDesc);
      socket.off("call:ice-candidate", onCandidate);
      socket.off("call:ice-candidates", onCandidates);
      socket.off("call:end", onEnd);
    };
  }, [cleanup, handleDescription, isAudioCallActive, socket]);

  useEffect(() => {
    if (!isAudioCallActive) return;
    if (!socket || activeCall?.isCaller) return;
    const callId = activeCall?.callId;
    const callerId = getTargetId();
    if (!callId) return;

    let attempts = 0;
    const sendAccept = () => {
      if (hasReceivedOffer.current) return;
      attempts += 1;
      socket.emit("call:accept", { callId, callerId });
      if (attempts >= 12) clearAcceptRetry();
    };

    sendAccept();
    acceptRetryRef.current = setInterval(sendAccept, 1200);

    return () => clearAcceptRetry();
  }, [
    activeCall?.callId,
    activeCall?.isCaller,
    clearAcceptRetry,
    getTargetId,
    isAudioCallActive,
    socket,
  ]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const endCall = () => {
    const to = getTargetId();
    if (to) socket?.emit("call:end", { to });
    cleanup();
  };

  const toggleMute = () => {
    setIsMuted((prev) => !prev);
  };

  const toggleSpeaker = () => {
    const nextSpeakerState = !isSpeakerOn;

    if (isNativePlatform && nativeAudioRoutingPreparedRef.current) {
      setIsSpeakerOn(nextSpeakerState);
      NativeCallPlugin.setSpeakerRoute({ enabled: nextSpeakerState })
        .then((res) => {
          if (typeof res?.speakerOn === "boolean") {
            setIsSpeakerOn(Boolean(res.speakerOn));
          }
        })
        .catch(() => {
          setIsSpeakerOn((prev) => !prev);
        });
      return;
    }

    setIsSpeakerOn(nextSpeakerState);
  };

  const otherUserName = activeCall?.otherUserName || "Unknown";
  const otherUserImage = activeCall?.otherUserImage || "";
  const userInitial = otherUserName.charAt(0).toUpperCase() || "U";
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

  if (!isAudioCallActive) return null;

  return (
    <>
      <audio ref={remoteAudioRef} autoPlay />
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
                {otherUserImage ? (
                  <AvatarImage src={otherUserImage} alt="avatar" />
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
                  {otherUserName}
                </span>
              <div className="flex items-center gap-1.5">
                {getConnectionIcon()}
                <CallTimer
                  connectionStatus={connectionStatus}
                  startTimestamp={activeCall?.callStartedAt}
                  className="text-primary text-xs font-medium"
                />
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
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px]" />
              <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-primary/5 rounded-full blur-[100px]" />
            </div>
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
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 25, delay: 0.15 }}
                className="relative mb-8"
              >
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
                <Avatar className="h-32 w-32 sm:h-40 sm:w-40 ring-4 ring-primary/30 shadow-lg">
                    {otherUserImage ? (
                      <AvatarImage
                        src={otherUserImage}
                        alt="avatar"
                        className="object-cover"
                      />
                  ) : (
                    <AvatarFallback className="bg-primary text-primary-foreground text-5xl sm:text-6xl font-bold">
                      {userInitial}
                    </AvatarFallback>
                  )}
                </Avatar>
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
              <motion.h2
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-foreground text-2xl sm:text-3xl font-semibold mb-2"
              >
                {otherUserName}
              </motion.h2>
              <CallTimer
                connectionStatus={connectionStatus}
                startTimestamp={activeCall?.callStartedAt}
                className="text-primary text-lg font-medium"
              />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30, delay: 0.3 }}
              className="absolute bottom-8 left-0 right-0 flex justify-center safe-area-bottom"
            >
              <div className="flex items-center gap-4 bg-background-secondary/80 backdrop-blur-xl rounded-full px-6 py-4 border border-border shadow-lg">
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
                <button
                  onClick={endCall}
                  className="w-16 h-16 rounded-full bg-destructive hover:bg-destructive/90 flex items-center justify-center text-destructive-foreground transition-all duration-200 shadow-lg hover:shadow-destructive/30"
                >
                  <IoCall className="w-7 h-7 rotate-[135deg]" />
                </button>
                <button
                  onClick={toggleSpeaker}
                  className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 ${
                    isSpeakerOn
                      ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
                      : "bg-accent hover:bg-accent/80 text-foreground"
                  }`}
                >
                  <IoVolumeHigh className="w-6 h-6" />
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
