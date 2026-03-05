import { Suspense, lazy, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import useAppStore from "@/store";
import { useSocket } from "@/context/SocketContext";
import NativeCallPlugin from "@/plugins/NativeCallPlugin";
import axios from "axios";
import { GET_TURN_CREDENTIALS } from "@/utils/constants";

const AudioCallScreen = lazy(() => import("@/components/AudioCallScreen"));
const VideoCallScreen = lazy(() => import("@/components/VideoCallScreen"));

const NativeCallHandler = () => {
  const {
    activeCall,
    clearActiveCall,
    callAccepted,
    clearCallAccepted,
    setCallMinimized,
  } = useAppStore();
  const { socket } = useSocket();
  const initialized = useRef(false);
  const nativeReadyRef = useRef(false);
  const listenersRef = useRef([]);
  const iceServersRef = useRef(null);
  const syncRetryTimeoutRef = useRef(null);
  const peerConnectionRetryTimeoutRef = useRef(null);
  const callerOfferRetryTimeoutRef = useRef(null);
  const acceptRetryIntervalRef = useRef(null);
  const acceptRetryAttemptsRef = useRef(0);
  const remoteOfferSeenRef = useRef(false);
  const peerConnectionCreatingRef = useRef(false);
  const lastSyncedStartRef = useRef(0);
  const remoteEndInProgressRef = useRef(false);
  const callFinalizedRef = useRef(false);
  const localOfferSentRef = useRef(false);
  const pipModeRef = useRef(false);
  const callUiVisibleRef = useRef(true);
  const uiStateProbeTokenRef = useRef(0);
  const uiStateProbeTimeoutRef = useRef(null);
  // Bug B fix: store named socket handler references so cleanup can unregister
  // exactly those handlers. socket.off("event") with no reference removes ALL
  // listeners for that event — including the global SocketContext handler — which
  // permanently disables call-end detection in subsequent calls this session.
  const socketHandlersRef = useRef({});

  const syncMinimizedState = () => {
    const hasActiveCall = Boolean(useAppStore.getState().activeCall);
    const shouldShowBanner =
      hasActiveCall && !pipModeRef.current && !callUiVisibleRef.current;
    setCallMinimized(shouldShowBanner);
  };

  const finalizeCallState = () => {
    if (callFinalizedRef.current) return;
    callFinalizedRef.current = true;
    clearActiveCall();
    clearCallAccepted();
    setCallMinimized(false);
    initialized.current = false;
    nativeReadyRef.current = false;
    pipModeRef.current = false;
    callUiVisibleRef.current = false;
    uiStateProbeTokenRef.current += 1;
    clearUiStateProbeTimeout();
    clearSyncRetryTimeout();
    clearPeerConnectionRetryTimeout();
    clearCallerOfferRetryTimeout();
    clearAcceptRetryInterval();
    peerConnectionCreatingRef.current = false;
    remoteOfferSeenRef.current = false;
    localOfferSentRef.current = false;
    lastSyncedStartRef.current = 0;
  };

  const clearSyncRetryTimeout = () => {
    if (syncRetryTimeoutRef.current) {
      clearTimeout(syncRetryTimeoutRef.current);
      syncRetryTimeoutRef.current = null;
    }
  };

  const clearPeerConnectionRetryTimeout = () => {
    if (peerConnectionRetryTimeoutRef.current) {
      clearTimeout(peerConnectionRetryTimeoutRef.current);
      peerConnectionRetryTimeoutRef.current = null;
    }
  };

  const clearCallerOfferRetryTimeout = () => {
    if (callerOfferRetryTimeoutRef.current) {
      clearTimeout(callerOfferRetryTimeoutRef.current);
      callerOfferRetryTimeoutRef.current = null;
    }
  };

  const clearAcceptRetryInterval = () => {
    if (acceptRetryIntervalRef.current) {
      clearInterval(acceptRetryIntervalRef.current);
      acceptRetryIntervalRef.current = null;
    }
    acceptRetryAttemptsRef.current = 0;
  };

  const clearUiStateProbeTimeout = () => {
    if (uiStateProbeTimeoutRef.current) {
      clearTimeout(uiStateProbeTimeoutRef.current);
      uiStateProbeTimeoutRef.current = null;
    }
  };

  const syncStateFromNative = async (token) => {
    try {
      const uiState = await NativeCallPlugin.getCallUiState();
      if (token !== uiStateProbeTokenRef.current) return;
      pipModeRef.current = Boolean(uiState?.isPip);
      callUiVisibleRef.current = Boolean(uiState?.isVisible);
      syncMinimizedState();
    } catch {
      if (token !== uiStateProbeTokenRef.current) return;
      // Keep previous refs when probing fails to avoid false banner spikes.
    }
  };

  const syncCallStartTimeToNative = (rawCallStartedAt, attempt = 0) => {
    const callStartedAt = Number(rawCallStartedAt);
    if (!Number.isFinite(callStartedAt) || callStartedAt <= 0) return;
    if (lastSyncedStartRef.current === callStartedAt) return;

    const maxAttempts = 10;
    const retryDelayMs = 300;

    const retry = () => {
      if (attempt >= maxAttempts) return;
      clearSyncRetryTimeout();
      syncRetryTimeoutRef.current = setTimeout(() => {
        syncCallStartTimeToNative(callStartedAt, attempt + 1);
      }, retryDelayMs);
    };

    if (!nativeReadyRef.current) {
      retry();
      return;
    }

    NativeCallPlugin.syncCallStartTime({ callStartedAt })
      .then(() => {
        lastSyncedStartRef.current = callStartedAt;
        clearSyncRetryTimeout();
      })
      .catch(() => {
        retry();
      });
  };

  const ensurePeerConnectionReady = async (iceServers, attempt = 0) => {
    if (callFinalizedRef.current) return false;
    if (peerConnectionCreatingRef.current) return false;

    const maxAttempts = 20;
    const retryDelayMs = 160;

    if (!nativeReadyRef.current) {
      if (attempt >= maxAttempts) return false;
      clearPeerConnectionRetryTimeout();
      return new Promise((resolve) => {
        peerConnectionRetryTimeoutRef.current = setTimeout(async () => {
          resolve(await ensurePeerConnectionReady(iceServers, attempt + 1));
        }, retryDelayMs);
      });
    }

    peerConnectionCreatingRef.current = true;
    try {
      await NativeCallPlugin.createPeerConnection({ iceServers });
      clearPeerConnectionRetryTimeout();
      return true;
    } catch {
      if (attempt >= maxAttempts) return false;
      return new Promise((resolve) => {
        peerConnectionRetryTimeoutRef.current = setTimeout(async () => {
          resolve(await ensurePeerConnectionReady(iceServers, attempt + 1));
        }, retryDelayMs);
      });
    } finally {
      peerConnectionCreatingRef.current = false;
    }
  };

  useEffect(() => {
    if (!activeCall || !socket) return;
    if (initialized.current) return;

    const setupNativeCall = async () => {
      initialized.current = true;
      callFinalizedRef.current = false;
      remoteEndInProgressRef.current = false;
      pipModeRef.current = false;
      callUiVisibleRef.current = true;
      remoteOfferSeenRef.current = false;
      localOfferSentRef.current = false;
      clearAcceptRetryInterval();

      // Register socket signaling handlers immediately so early offer/ICE packets
      // are not dropped while native startup is in progress.
      const onOffer = ({ description }) => {
        if (!description?.sdp) return;
        remoteOfferSeenRef.current = true;
        clearAcceptRetryInterval();
        NativeCallPlugin.handleRemoteOffer({
          sdp: description.sdp,
          type: description.type,
        }).catch(() => { });
      };

      const onAnswer = ({ description }) => {
        if (!description?.sdp) return;
        NativeCallPlugin.handleRemoteAnswer({ sdp: description.sdp }).catch(() => { });
      };

      const onCandidate = ({ candidate }) => {
        if (!candidate?.candidate) return;
        NativeCallPlugin.addIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        }).catch(() => { });
      };

      const onCandidates = ({ candidates }) => {
        if (!Array.isArray(candidates) || candidates.length === 0) return;
        NativeCallPlugin.addIceCandidates({ candidates }).catch(() => { });
      };

      const onEnd = () => {
        remoteEndInProgressRef.current = true;
        NativeCallPlugin.endCall().catch(() => {
          remoteEndInProgressRef.current = false;
        });
        finalizeCallState();
      };

      socketHandlersRef.current = { onOffer, onAnswer, onCandidate, onCandidates, onEnd };
      socket.on("call:offer", onOffer);
      socket.on("call:answer", onAnswer);
      socket.on("call:ice-candidate", onCandidate);
      socket.on("call:ice-candidates", onCandidates);
      socket.on("call:end", onEnd);

      try {
        nativeReadyRef.current = false;
        lastSyncedStartRef.current = 0;
        clearSyncRetryTimeout();

        // Initialize native WebRTC engine
        await NativeCallPlugin.initialize();
        setCallMinimized(false);

        // Register native signaling listeners immediately after initialize so
        // caller-side offer generation cannot outrun JS listener attachment.
        listenersRef.current.push(
          await NativeCallPlugin.addListener("onLocalOffer", (data) => {
            localOfferSentRef.current = true;
            const to = activeCall.otherUserId || activeCall.callerId;
            socket.emit("call:offer", { to, description: data });
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onLocalAnswer", (data) => {
            const to = activeCall.otherUserId || activeCall.callerId;
            socket.emit("call:answer", { to, description: data });
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onIceCandidates", (data) => {
            const to = activeCall.otherUserId || activeCall.callerId;
            socket.emit("call:ice-candidates", {
              to,
              candidates: data.candidates,
            });
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onCallEnded", () => {
            const shouldNotifyRemote = !remoteEndInProgressRef.current;
            remoteEndInProgressRef.current = false;
            if (shouldNotifyRemote) {
              const to = activeCall.otherUserId || activeCall.callerId;
              if (to) socket.emit("call:end", { to });
            }
            finalizeCallState();
          }),
        );

        const onLocalVideoFailure = await NativeCallPlugin.addListener(
          "onLocalVideoFailure",
          (data) => {
            const reason = data?.reason || "unknown";
            const details = data?.details || "";
            console.error(
              `Native local video failed (${reason})${details ? `: ${details}` : ""}`,
            );

            const currentCall = useAppStore.getState().activeCall;
            if (!currentCall || currentCall.callType !== "video" || callFinalizedRef.current) {
              return;
            }

            const to = currentCall.otherUserId || currentCall.callerId;
            if (to) {
              socket.emit("call:end", { to, reason: "local_video_failure" });
            }
            remoteEndInProgressRef.current = true;
            NativeCallPlugin.endCall().catch(() => {
              remoteEndInProgressRef.current = false;
            });
            alert("Your camera could not start reliably. Please retry the call.");
            finalizeCallState();
          },
        );
        listenersRef.current.push(onLocalVideoFailure);

        // Start native call UI
        try {
          await NativeCallPlugin.startCall({
            callType: activeCall.callType,
            isCaller: activeCall.isCaller,
            otherUserName: activeCall.otherUserName || "Unknown",
            otherUserImage: activeCall.otherUserImage || "",
          });
          nativeReadyRef.current = true;
          pipModeRef.current = false;
          callUiVisibleRef.current = true;
          setCallMinimized(false);
        } catch (startError) {
          console.error("Failed to start native call (permission denied or error):", startError);
          // If the user denied permissions, the plugin rejects. We must abort the call.
          alert(`Could not start call: ${startError.message || "Permissions denied"}`);
          const to = activeCall?.otherUserId || activeCall?.callerId;
          if (to) socket.emit("call:end", { to, reason: "permission_denied" });
          await NativeCallPlugin.endCall().catch(() => { });
          finalizeCallState();
          return; // Abort further WebRTC setup
        }

        // Fetch TURN credentials
        let iceServers = [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ];
        try {
          const res = await axios.get(GET_TURN_CREDENTIALS, {
            withCredentials: true,
          });
          if (res.data.success && res.data.iceServers) {
            iceServers = res.data.iceServers;
          }
        } catch {
          // Use default STUN
        }
        iceServersRef.current = iceServers;
        syncCallStartTimeToNative(useAppStore.getState().activeCall?.callStartedAt);

      } catch (e) {
        console.error("Failed to start native call:", e);
        nativeReadyRef.current = false;
        clearActiveCall();
        return;
      }

      // If callee, send accept and create peer connection immediately
      if (!activeCall.isCaller) {
        const callId = activeCall.callId;
        const callerId = activeCall.otherUserId || activeCall.callerId;
        if (callId) {
          const sendAccept = () => {
            if (remoteOfferSeenRef.current) {
              clearAcceptRetryInterval();
              return;
            }
            acceptRetryAttemptsRef.current += 1;
            socket.emit("call:accept", { callId, callerId });
            if (acceptRetryAttemptsRef.current >= 6) {
              clearAcceptRetryInterval();
            }
          };

          clearAcceptRetryInterval();
          sendAccept();
          acceptRetryIntervalRef.current = setInterval(sendAccept, 1500);
        }
        await ensurePeerConnectionReady(iceServersRef.current);
      }

      const onUiVisibilityChanged = await NativeCallPlugin.addListener(
        "onCallUiVisibilityChanged",
        (data) => {
          const isVisible = Boolean(data?.isVisible);
          if (!isVisible) {
            // UI became hidden (activity stopped/closed, or × PiP dismiss).
            // Clear the PiP-exit guard so the probe reads actual native state.
            clearUiStateProbeTimeout();
            const token = ++uiStateProbeTokenRef.current;
            uiStateProbeTimeoutRef.current = setTimeout(() => {
              syncStateFromNative(token);
            }, 90);
            return;
          }
          uiStateProbeTokenRef.current += 1;
          clearUiStateProbeTimeout();
          callUiVisibleRef.current = isVisible;
          syncMinimizedState();
        },
      );
      listenersRef.current.push(onUiVisibilityChanged);

      // When PiP mode changes, update pipModeRef and re-evaluate banner state.
      // IMPORTANT: When exiting PiP (isPip=false) do NOT cancel any existing probe.
      // The × dismiss case relies on a probe already scheduled by onStop's
      // onCallUiVisibilityChanged(false). Killing it here (by incrementing the token)
      // prevents the banner from ever showing. We only cancel probes on PiP entry
      // (isPip=true) where the call is going INTO the PiP window and any probe that
      // would show the banner is spurious.
      const onPipChange = await NativeCallPlugin.addListener("onPipModeChanged", (data) => {
        const isPip = Boolean(data?.isPip);
        pipModeRef.current = isPip;
        if (isPip) {
          // Entering PiP: cancel any pending banner-showing probe.
          uiStateProbeTokenRef.current += 1;
          clearUiStateProbeTimeout();
        }
        // Exiting PiP (isPip=false): just re-evaluate. Any in-flight probe from
        // onStop's onCallUiVisibilityChanged(false) will run and show the banner
        // (× dismiss), or onResume's onCallUiVisibilityChanged(true) will clear
        // callUiVisibleRef and keep the banner hidden (expand to fullscreen).
        syncMinimizedState();
      });
      listenersRef.current.push(onPipChange);

      const onCallUiClosed = await NativeCallPlugin.addListener("onCallUiClosed", () => {
        if (pipModeRef.current) {
          return;
        }
        clearUiStateProbeTimeout();
        const token = ++uiStateProbeTokenRef.current;
        uiStateProbeTimeoutRef.current = setTimeout(() => {
          syncStateFromNative(token);
        }, 60);
      });
      listenersRef.current.push(onCallUiClosed);
    };

    setupNativeCall();

    return () => {
      // Cleanup listeners
      listenersRef.current.forEach((l) => l?.remove?.());
      listenersRef.current = [];
      callFinalizedRef.current = false;
      remoteEndInProgressRef.current = false;
      nativeReadyRef.current = false;
      pipModeRef.current = false;
      callUiVisibleRef.current = false;
      uiStateProbeTokenRef.current += 1;
      clearUiStateProbeTimeout();
      clearSyncRetryTimeout();
      clearPeerConnectionRetryTimeout();
      clearCallerOfferRetryTimeout();
      clearAcceptRetryInterval();
      peerConnectionCreatingRef.current = false;
      remoteOfferSeenRef.current = false;
      localOfferSentRef.current = false;
      lastSyncedStartRef.current = 0;
      // Bug B fix: unregister with exact handler references so we don't accidentally
      // strip the global SocketContext listeners for these events.
      const h = socketHandlersRef.current;
      socket.off("call:offer", h.onOffer);
      socket.off("call:answer", h.onAnswer);
      socket.off("call:ice-candidate", h.onCandidate);
      socket.off("call:ice-candidates", h.onCandidates);
      socket.off("call:end", h.onEnd);
      socketHandlersRef.current = {};
      initialized.current = false;

      // Crucial: When the React component unmounts (e.g., due to call-rejected clearing activeCall),
      // we must explicitly inform the Native plugin to destroy the CallActivity.
      NativeCallPlugin.endCall().catch(() => { });
    };
  }, [
    socket,
    activeCall?.callId,
    activeCall?.callType,
    activeCall?.isCaller,
    activeCall?.otherUserId,
    activeCall?.callerId,
    activeCall?.otherUserName,
    setCallMinimized,
    clearActiveCall,
    clearCallAccepted,
  ]);

  // Handle callAccepted for caller
  useEffect(() => {
    if (!callAccepted || !activeCall?.isCaller) return;

    // Callee accepted. Create PeerConnection, triggering renegotiation to send offer.
    const createPC = async () => {
      const iceServers = iceServersRef.current || [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
      ];
      const created = await ensurePeerConnectionReady(iceServers);
      if (created) {
        let kickstartAttempts = 0;
        const maxKickstartAttempts = 3;
        const kickstartDelayMs = 450;

        const tryKickstartOffer = () => {
          if (
            callFinalizedRef.current ||
            localOfferSentRef.current ||
            remoteOfferSeenRef.current
          ) {
            return;
          }
          NativeCallPlugin.kickstartOffer().catch(() => { });
        };

        const scheduleKickstartRetry = () => {
          clearCallerOfferRetryTimeout();
          callerOfferRetryTimeoutRef.current = setTimeout(() => {
            if (
              callFinalizedRef.current ||
              localOfferSentRef.current ||
              remoteOfferSeenRef.current
            ) {
              return;
            }

            kickstartAttempts += 1;
            tryKickstartOffer();

            if (
              kickstartAttempts < maxKickstartAttempts &&
              !localOfferSentRef.current &&
              !remoteOfferSeenRef.current
            ) {
              scheduleKickstartRetry();
            }
          }, kickstartDelayMs);
        };

        tryKickstartOffer();
        clearCallerOfferRetryTimeout();
        scheduleKickstartRetry();
        clearCallAccepted();
      } else {
        // Bug E fix: PeerConnection creation failed (e.g. native plugin initializing
        // too slowly, or createPeerConnection rejected repeatedly). Without this branch
        // the call hangs open silently — CallActivity is visible but no signaling occurs.
        // Tear down both sides cleanly.
        console.error("[NativeCallHandler] PeerConnection creation failed — terminating call");
        const to = activeCall?.otherUserId || activeCall?.callerId;
        if (to) {
          const h = socketHandlersRef.current;
          // Temporarily suppress our own onEnd handler so we don't double-finalize
          if (h.onEnd) socket.off("call:end", h.onEnd);
          socket.emit("call:end", { to, reason: "peer_connection_failed" });
          if (h.onEnd) socket.on("call:end", h.onEnd);
        }
        await NativeCallPlugin.endCall().catch(() => { });
        finalizeCallState();
      }
    };

    createPC();
  }, [callAccepted, activeCall?.isCaller, clearCallAccepted]);

  useEffect(() => {
    if (!activeCall?.callStartedAt) return;
    syncCallStartTimeToNative(activeCall.callStartedAt);
  }, [activeCall?.callStartedAt]);

  return null; // No UI — native Activity handles it
};

const CallContainer = () => {
  const { activeCall } = useAppStore();

  if (!activeCall) return null;

  // On native Capacitor: use native plugin
  if (Capacitor.isNativePlatform()) {
    return <NativeCallHandler />;
  }

  // On web: use existing WebView components
  if (activeCall.callType === "video") {
    return (
      <Suspense fallback={null}>
        <VideoCallScreen />
      </Suspense>
    );
  }

  if (activeCall.callType === "audio") {
    return (
      <Suspense fallback={null}>
        <AudioCallScreen />
      </Suspense>
    );
  }

  return null;
};

export default CallContainer;

