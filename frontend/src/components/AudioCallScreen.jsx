import { useState, useEffect, useRef, useCallback } from "react";
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
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import axios from "axios";
import { GET_TURN_CREDENTIALS } from "@/utils/constants";

// Default STUN servers (Fallback)
const DEFAULT_ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

const AudioCallScreen = () => {
  const { activeCall, clearActiveCall } = useAppStore();
  const { socket } = useSocket();

  // UI states
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true); // Default to speaker for calls
  const [isMinimized, setIsMinimized] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("initializing"); // initializing, connected, disconnected, failed

  // Call State
  const [callStatus, setCallStatus] = useState(
    activeCall.isCaller ? "ringing" : "connected",
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

  if (!activeCall || activeCall.callType !== "audio") return null;

  // waake lock screen
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

    // Handle Tab Close (Ghost Call Prevention)
    const handleBeforeUnload = (e) => {
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
        // Audio only
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        localStreamRef.current = stream;

        // Handle Hardware Failure (Mic unplugged)
        stream.getAudioTracks()[0].onended = () => {
          console.warn("Mic ended unexpectedly. Restarting...");
          handleDeviceChange();
        };

        if (!activeCall.isCaller) initializePeerConnection(stream);
      } catch (err) {
        console.error("Media Error:", err);
        setConnectionStatus("failed"); // Update UI to show error
      }
    };

    startMedia();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, []);

  //Restart Media on device change
  const handleDeviceChange = async () => {
    console.log("Device change (e.g. headphones). Refreshing stream...");
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      localStreamRef.current = newStream;

      // Replace track in existing connection seamlessly
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
    if (!socket || !activeCall.isCaller) return;
    const handleCallAccepted = () => {
      setCallStatus("connected");
      if (localStreamRef.current)
        initializePeerConnection(localStreamRef.current);
    };
    socket.on("call-accepted", handleCallAccepted);
    return () => socket.off("call-accepted", handleCallAccepted);
  }, [socket, activeCall.isCaller]);

  // Robust Peer Connection Logic
  const initializePeerConnection = async (stream) => {
    if (pc.current) return;

    let config = { ...DEFAULT_ICE_SERVERS };

    // Fetch TURN Credentials
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

    // Add Audio Track
    stream.getTracks().forEach((track) => pc.current.addTrack(track, stream));

    // Handle Remote Audio
    pc.current.ontrack = ({ track, streams }) => {
      remoteStreamRef.current = streams[0] || new MediaStream([track]);

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
        remoteAudioRef.current
          .play()
          .catch((e) => console.error("Audio Play Error", e));
      }
    };

    // ICE Candidates
    pc.current.onicecandidate = ({ candidate }) => {
      if (candidate)
        socket.emit("call:ice-candidate", {
          to: activeCall.otherUserId || activeCall.callerId,
          candidate,
        });
    };

    // Robust Connection Health & Aggressive Reconnection
    pc.current.oniceconnectionstatechange = () => {
      const state = pc.current.iceConnectionState;
      setConnectionStatus(state);

      if (connectionTimeout.current) clearTimeout(connectionTimeout.current);

      if (state === "disconnected") {
        // Aggressive Restart after 2s
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

    // Perfect Negotiation
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

    // Flush Buffer
    if (pendingOffer.current) {
      await handleDescription(
        pendingOffer.current.description,
        pendingOffer.current.from,
      );
      pendingOffer.current = null;
    }
    while (pendingCandidates.current.length > 0) {
      await pc.current.addIceCandidate(pendingCandidates.current.shift());
    }
  };

  // Signaling Handler
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

  // Socket Listeners
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

  // Utils
  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pc.current?.close();
    pc.current = null;
    if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
    clearActiveCall();
  }, [clearActiveCall]);

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

  // Duration Timer
  useEffect(() => {
    let t;
    if (connectionStatus === "connected" || connectionStatus === "completed") {
      t = setInterval(() => setCallDuration((p) => p + 1), 1000);
    }
    return () => clearInterval(t);
  }, [connectionStatus]);

  const formatDuration = (s) =>
    `${Math.floor(s / 60)
      .toString()
      .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
  const userInitial = activeCall.otherUserName?.charAt(0).toUpperCase() || "U";

  // Render
  return (
    <>
      <audio ref={remoteAudioRef} autoPlay />
      {isMinimized ? (
        <div
          onClick={() => setIsMinimized(false)}
          className="fixed top-12 right-4 z-50 flex items-center gap-3 bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-2xl p-2 pr-4 shadow-2xl cursor-pointer animate-in fade-in slide-in-from-top-5 duration-300"
        >
          <div className="relative w-10 h-10 flex-shrink-0">
            <div className="absolute inset-0 bg-green-500 rounded-full animate-ping opacity-20" />
            <div className="relative w-full h-full bg-gradient-to-br from-emerald-500 to-green-600 rounded-full flex items-center justify-center text-white font-bold">
              {userInitial}
            </div>
          </div>

          <div className="flex flex-col">
            <span className="text-white text-sm font-semibold leading-tight">
              {activeCall.otherUserName}
            </span>
            <span className="text-emerald-400 text-xs font-mono">
              {formatDuration(callDuration)}
            </span>
          </div>
        </div>
      ) : (
        // Full Screen View
        <div className="fixed inset-0 z-50 bg-gradient-to-b from-slate-900 via-slate-800 to-slate-950 flex flex-col items-center justify-between py-12 px-6 overflow-hidden">
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-emerald-500/10 rounded-full blur-[100px]" />
            <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-500/10 rounded-full blur-[100px]" />
          </div>

          <div className="w-full flex justify-between items-start z-10">
             <div className="flex flex-col items-start">
                 <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded-full border border-white/5 backdrop-blur-md">
                     <div className={`w-2 h-2 rounded-full ${connectionStatus === 'connected' ? 'bg-emerald-500' : 'bg-yellow-500'} animate-pulse`} />
                     <span className="text-xs text-white/70 font-medium capitalize">
                        {callStatus === "ringing" ? "Ringing..." : connectionStatus}
                     </span>
                 </div>
             </div>
             <button 
                onClick={() => setIsMinimized(true)} 
                className="p-3 bg-white/5 hover:bg-white/10 rounded-full text-white backdrop-blur-md transition-all"
             >
                <IoChevronDown size={24} />
             </button>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center w-full z-10 mb-20">
            <div className="relative mb-8">
              {connectionStatus === "connected" && (
                <>
                  <div
                    className="absolute inset-0 bg-emerald-500/20 rounded-full animate-ping"
                    style={{ animationDuration: "3s" }}
                  />
                  <div className="absolute inset-[-20px] bg-emerald-500/10 rounded-full animate-pulse" />
                </>
              )}
              <div className="relative w-32 h-32 md:w-40 md:h-40 rounded-full bg-gradient-to-br from-slate-700 to-slate-600 border-4 border-slate-800 shadow-2xl flex items-center justify-center overflow-hidden">
                <span className="text-5xl md:text-6xl font-bold text-white/90">
                  {userInitial}
                </span>
              </div>
            </div>

            <h2 className="text-2xl md:text-3xl font-bold text-white mb-2">
              {activeCall.otherUserName}
            </h2>
            <p className="text-emerald-400 font-mono text-lg tracking-wider bg-emerald-500/10 px-4 py-1 rounded-full">
              {formatDuration(callDuration)}
            </p>
          </div>

          <div className="w-full max-w-md z-20 pb-8">
            <div className="flex items-center justify-center gap-6">
              <button
                onClick={toggleMute}
                className={`p-4 rounded-full transition-all duration-300 ${isMuted ? "bg-white text-slate-900" : "bg-white/10 text-white hover:bg-white/20 backdrop-blur-md"}`}
              >
                {isMuted ? <IoMicOff size={28} /> : <IoMic size={28} />}
              </button>

              <button
                onClick={endCall}
                className="p-6 rounded-full bg-red-500 text-white shadow-xl shadow-red-500/30 hover:bg-red-600 hover:scale-105 active:scale-95 transition-all"
              >
                <IoCall size={32} className="rotate-[135deg]" />
              </button>

              <button
                onClick={() => setIsSpeakerOn(!isSpeakerOn)}
                className={`p-4 rounded-full transition-all duration-300 ${!isSpeakerOn ? "bg-white text-slate-900" : "bg-white/10 text-white hover:bg-white/20 backdrop-blur-md"}`}
              >
                {isSpeakerOn ? (
                  <IoVolumeHigh size={28} />
                ) : (
                  <IoVolumeMute size={28} />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AudioCallScreen;
