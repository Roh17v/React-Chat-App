import { useState, useEffect, useRef, useCallback } from "react";
import {
  IoCall,
  IoMicOff,
  IoMic,
  IoVolumeHigh,
  IoVolumeMute,
  IoChevronDown,
  IoExpand,
} from "react-icons/io5";
import useAppStore from "@/store";
import useMediaStream from "@/hooks/useMediaStream";
import usePeerConnection from "@/hooks/usePeerConnection";
import { useSocket } from "@/context/SocketContext";

const AudioCallScreen = () => {
  const { activeCall, clearActiveCall } = useAppStore();
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [pulse, setPulse] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);

  // LOGIC STATE
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isCallAccepted, setIsCallAccepted] = useState(false);

  const { socket } = useSocket();
  const remoteAudioRef = useRef(null);
  const callInitiated = useRef(false);

  const { startMedia, stopMedia, localStreamRef } = useMediaStream();
  const { createPeerConnection, addLocalTracks, closeConnection, pcRef } =
    usePeerConnection();

  // End Call Logic
  const endCall = useCallback(() => {
    const targetId = activeCall?.otherUserId || activeCall?.callerId;

    if (targetId) {
      socket.emit("call:end", { to: targetId });
    }
    closeConnection();
    stopMedia();
    clearActiveCall();
    callInitiated.current = false;
    setLocalStream(null);
    setRemoteStream(null);
    setIsCallAccepted(false);
  }, [activeCall, closeConnection, stopMedia, clearActiveCall, socket]);

  if (!activeCall) return null;

  // Setup Media
  useEffect(() => {
    let mounted = true;
    startMedia("audio").then((stream) => {
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

  useEffect(() => {
    if (!socket) return;

    const handleCallAccepted = () => setIsCallAccepted(true);
    const handleRemoteEnd = () => {
      console.log("🛑 Remote user hung up.");
      endCall();
    };

    if (!activeCall.isCaller) setIsCallAccepted(true);

    socket.on("call-accepted", handleCallAccepted);
    socket.on("call:end", handleRemoteEnd);

    return () => {
      socket.off("call-accepted", handleCallAccepted);
      socket.off("call:end", handleRemoteEnd);
    };
  }, [socket, activeCall.isCaller, endCall]);

  useEffect(() => {
    if (!activeCall.isCaller || !socket || !localStream || !isCallAccepted)
      return;
    if (callInitiated.current) return;
    callInitiated.current = true;

    const startCall = async () => {
      const pc = await createPeerConnection(
        (candidate) => {
          socket.emit("call:ice-candidate", {
            to: activeCall.otherUserId,
            candidate,
          });
        },
        (stream) => {
          setRemoteStream(stream);
        },
      );

      addLocalTracks(localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("call:offer", { to: activeCall.otherUserId, offer });
    };

    startCall();
  }, [activeCall, socket, localStream, isCallAccepted]);

  // RECEIVER LOGIC
  useEffect(() => {
    if (!socket) return;

    const handleOffer = async ({ offer, from }) => {
      const pc = await createPeerConnection(
        (candidate) => {
          socket.emit("call:ice-candidate", { to: from, candidate });
        },
        (stream) => {
          setRemoteStream(stream);
        },
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
  }, [socket]);

  // ATTACH REMOTE AUDIO
  useEffect(() => {
    if (remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current
        .play()
        .catch((e) => console.error("Audio play error", e));
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current
      .getAudioTracks()
      .forEach((track) => (track.enabled = !isMuted));
  }, [isMuted]);

  useEffect(() => {
    if (!isCallAccepted) return;
    const durationInterval = setInterval(
      () => setCallDuration((prev) => prev + 1),
      1000,
    );
    const pulseInterval = setInterval(() => setPulse((p) => !p), 2000);
    return () => {
      clearInterval(durationInterval);
      clearInterval(pulseInterval);
    };
  }, [isCallAccepted]);

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const userInitial = activeCall.otherUserName?.charAt(0).toUpperCase() || "U";


  // Minimized view
  if (isMinimized) {
    return (
      <div className="fixed top-4 right-4 z-50 animate-in slide-in-from-top duration-300">
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 overflow-hidden">
          <button
            onClick={() => setIsMinimized(false)}
            className="w-full p-3 flex items-center gap-3 hover:bg-white/5 transition-colors"
          >
            {/* Avatar */}
            <div className="relative">
              <div
                className={`absolute inset-0 rounded-full bg-gradient-to-r from-emerald-500/30 to-green-500/30 blur-md transition-all duration-2000 ${pulse ? "scale-100" : "scale-110"}`}
              />
              <div className="relative w-12 h-12 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-lg font-bold text-white">
                {userInitial}
              </div>
            </div>

            {/* Call info */}
            <div className="flex-1 text-left">
              <p className="text-sm font-semibold text-white truncate max-w-[150px]">
                {activeCall.otherUserName || "Unknown User"}
              </p>
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs text-slate-400">
                  {formatDuration(callDuration)}
                </span>
              </div>
            </div>

            <IoExpand className="text-slate-400 text-lg flex-shrink-0" />
          </button>

          {/* Mini controls */}
          <div className="flex items-center gap-2 px-3 pb-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsMuted(!isMuted);
              }}
              className={`flex-1 py-2 px-3 rounded-lg flex items-center justify-center gap-2 transition-all ${
                isMuted
                  ? "bg-red-500/20 text-red-400"
                  : "bg-white/10 text-white hover:bg-white/15"
              }`}
            >
              {isMuted ? (
                <IoMicOff className="text-sm" />
              ) : (
                <IoMic className="text-sm" />
              )}
              <span className="text-xs">{isMuted ? "Muted" : "Mute"}</span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                endCall();
              }}
              className="py-2 px-4 rounded-lg bg-gradient-to-br from-red-500 to-red-600 text-white hover:shadow-lg hover:shadow-red-500/50 transition-all"
            >
              <IoCall className="text-sm rotate-[135deg]" />
            </button>
          </div>
        </div>
        {/* Hidden Audio Element for Remote Stream */}
        <audio ref={remoteAudioRef} autoPlay />
      </div>
    );
  }

  // 2. Full screen view
  return (
    <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col items-center justify-between py-8 sm:py-12 px-4 overflow-hidden">
      {/* Hidden Audio Element for Remote Stream */}
      <audio ref={remoteAudioRef} autoPlay />

      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className={`absolute top-1/4 left-1/2 -translate-x-1/2 w-72 h-72 sm:w-96 sm:h-96 bg-gradient-to-r from-emerald-500/10 to-green-500/10 rounded-full blur-3xl transition-all duration-2000 ${pulse ? "scale-100 opacity-40" : "scale-110 opacity-20"}`}
        />
        <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-500/5 to-purple-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-gradient-to-tr from-pink-500/5 to-rose-500/5 rounded-full blur-3xl" />
      </div>

      {/* Minimize button */}
      <button
        onClick={() => setIsMinimized(true)}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/10 flex items-center justify-center hover:bg-white/15 transition-all z-20 hover:scale-110 active:scale-95"
        aria-label="Minimize"
      >
        <IoChevronDown className="text-white text-xl" />
      </button>

      {/* Top info section */}
      <div className="relative flex flex-col items-center gap-6 mt-8 sm:mt-16 z-10">
        {/* Avatar with animated rings */}
        <div className="relative">
          <div
            className={`absolute inset-0 rounded-full bg-gradient-to-r from-emerald-500 to-green-500 opacity-20 transition-all duration-2000 ${pulse ? "scale-100" : "scale-110"}`}
          />
          <div
            className={`absolute -inset-2 rounded-full bg-gradient-to-r from-emerald-500/30 to-green-500/30 blur-md transition-all duration-2000 ${pulse ? "scale-100 opacity-50" : "scale-110 opacity-30"}`}
          />
          <div className="relative w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-5xl sm:text-6xl font-bold text-white shadow-2xl">
            {userInitial}
          </div>
        </div>

        {/* Call info */}
        <div className="text-center space-y-2">
          <h2 className="text-2xl sm:text-3xl font-bold text-white">
            {activeCall.otherUserName || "Unknown User"}
          </h2>
          <div className="flex items-center gap-2 justify-center">
            {isCallAccepted ? (
              <>
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-sm sm:text-base text-slate-300 font-medium">
                  Audio Call
                </p>
              </>
            ) : (
              <p className="text-sm sm:text-base text-slate-300 font-medium animate-pulse">
                {activeCall.isCaller ? "Calling..." : "Connecting..."}
              </p>
            )}
          </div>

          {isCallAccepted && (
            <p className="text-xl sm:text-2xl text-emerald-400 font-mono font-semibold">
              {formatDuration(callDuration)}
            </p>
          )}
        </div>

        {/* Call status indicator */}
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 backdrop-blur-sm border border-white/10">
          <div
            className={`w-2 h-2 rounded-full ${isCallAccepted ? "bg-emerald-500" : "bg-yellow-500"} animate-pulse`}
          />
          <span className="text-xs sm:text-sm text-slate-400">
            {isCallAccepted
              ? "Connected"
              : activeCall.isCaller
                ? "Ringing"
                : "Connecting"}
          </span>
        </div>
      </div>

      {/* Control buttons */}
      <div className="relative flex items-center justify-center gap-4 sm:gap-6 mb-8 sm:mb-12 z-10">
        {/* Mute button */}
        <button
          onClick={() => setIsMuted(!isMuted)}
          className={`group relative w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-all duration-300 ${
            isMuted
              ? "bg-white/20 backdrop-blur-sm"
              : "bg-white/10 backdrop-blur-sm hover:bg-white/15"
          } border border-white/10 hover:scale-110 active:scale-95`}
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          <div
            className={`absolute inset-0 rounded-full ${isMuted ? "bg-red-500/20" : "bg-white/5"} blur-lg transition-all duration-300`}
          />
          {isMuted ? (
            <IoMicOff className="text-xl sm:text-2xl text-red-400 relative z-10" />
          ) : (
            <IoMic className="text-xl sm:text-2xl text-white relative z-10" />
          )}
          <span className="absolute -bottom-6 text-xs text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
            {isMuted ? "Unmute" : "Mute"}
          </span>
        </button>

        {/* End call button */}
        <button
          onClick={endCall}
          className="group relative w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95"
          aria-label="End call"
        >
          <div className="absolute inset-0 bg-red-500/30 rounded-full blur-xl group-hover:bg-red-500/40 transition-all duration-300" />
          <div className="relative w-full h-full bg-gradient-to-br from-red-500 to-red-600 rounded-full flex items-center justify-center shadow-2xl shadow-red-500/50">
            <IoCall className="text-2xl sm:text-3xl text-white rotate-[135deg]" />
          </div>
          <span className="absolute -bottom-6 text-xs text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
            End
          </span>
        </button>

        {/* Speaker button */}
        <button
          onClick={() => setIsSpeakerOn(!isSpeakerOn)}
          className={`group relative w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-all duration-300 ${
            isSpeakerOn
              ? "bg-white/20 backdrop-blur-sm"
              : "bg-white/10 backdrop-blur-sm hover:bg-white/15"
          } border border-white/10 hover:scale-110 active:scale-95`}
          aria-label={isSpeakerOn ? "Speaker off" : "Speaker on"}
        >
          <div
            className={`absolute inset-0 rounded-full ${isSpeakerOn ? "bg-emerald-500/20" : "bg-white/5"} blur-lg transition-all duration-300`}
          />
          {isSpeakerOn ? (
            <IoVolumeHigh className="text-xl sm:text-2xl text-emerald-400 relative z-10" />
          ) : (
            <IoVolumeMute className="text-xl sm:text-2xl text-white relative z-10" />
          )}
          <span className="absolute -bottom-6 text-xs text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
            {isSpeakerOn ? "Speaker" : "Speaker"}
          </span>
        </button>
      </div>

      {/* Bottom hint text */}
      <div className="relative text-center text-xs sm:text-sm text-slate-500 z-10">
        <p>End-to-end encrypted</p>
      </div>
    </div>
  );
};

export default AudioCallScreen;
