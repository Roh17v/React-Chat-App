import { Suspense, lazy, useCallback, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import useAppStore from "@/store";
import {
  useSocket,
  queueCallEndForReconnect,
  queueCallMediaStateForReconnect,
} from "@/context/SocketContext";
import NativeCallPlugin from "@/plugins/NativeCallPlugin";
import axios from "axios";
import { GET_TURN_CREDENTIALS, HOST } from "@/utils/constants";
import { finalizeCallReliable } from "@/utils/callFinalize";
import { normalizeCallMediaState } from "@/utils/callMediaState";

const AudioCallScreen = lazy(() => import("@/components/AudioCallScreen"));
const VideoCallScreen = lazy(() => import("@/components/VideoCallScreen"));

const normalizeId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return value._id.toString();
  return value.toString();
};

const NativeCallHandler = () => {
  const MEDIA_STATE_RESYNC_MS = 4000;
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
  const localVideoStateSyncIntervalRef = useRef(null);
  const lastBroadcastLocalMediaStateRef = useRef(null);
  const lastMediaStateEmitAtRef = useRef(0);
  const connectionProbeTimeoutRef = useRef(null);
  const connectionProbeInFlightRef = useRef(false);
  const lastConnectionStateRef = useRef("new");
  const lastInactiveProbeAtRef = useRef(0);
  const callHeartbeatIntervalRef = useRef(null);
  const outgoingMediaSeqRef = useRef(0);
  const latestIncomingMediaSeqRef = useRef(-1);

  const getMediaStateSignature = (mediaState = {}) => {
    const normalizedState = normalizeCallMediaState(mediaState);
    return `${normalizedState.videoOff}:${normalizedState.videoSource}`;
  };
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
    clearLocalVideoStateSyncInterval();
    clearConnectionProbeTimeout();
    peerConnectionCreatingRef.current = false;
    connectionProbeInFlightRef.current = false;
    lastConnectionStateRef.current = "closed";
    lastInactiveProbeAtRef.current = 0;
    outgoingMediaSeqRef.current = 0;
    latestIncomingMediaSeqRef.current = -1;
    remoteOfferSeenRef.current = false;
    localOfferSentRef.current = false;
    lastSyncedStartRef.current = 0;
    lastBroadcastLocalMediaStateRef.current = null;
    lastMediaStateEmitAtRef.current = 0;
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

  const clearConnectionProbeTimeout = () => {
    if (connectionProbeTimeoutRef.current) {
      clearTimeout(connectionProbeTimeoutRef.current);
      connectionProbeTimeoutRef.current = null;
    }
  };

  const clearLocalVideoStateSyncInterval = () => {
    if (localVideoStateSyncIntervalRef.current) {
      clearInterval(localVideoStateSyncIntervalRef.current);
      localVideoStateSyncIntervalRef.current = null;
    }
  };

  const clearCallHeartbeatInterval = () => {
    if (callHeartbeatIntervalRef.current) {
      clearInterval(callHeartbeatIntervalRef.current);
      callHeartbeatIntervalRef.current = null;
    }
  };

  const emitCallEndReliable = useCallback(({ to, callId, reason } = {}) => {
    if (!to) return;
    const payload = {
      to,
      ...(callId ? { callId } : {}),
      ...(reason ? { reason } : {}),
    };
    const callSnapshot = useAppStore.getState().activeCall;
    void finalizeCallReliable({
      socket,
      ...payload,
      callStartedAt: callSnapshot?.callStartedAt,
    })
      .then((result) => {
        if (result?.ok) return;
        if (payload.callId) {
          queueCallEndForReconnect(payload);
        }
      })
      .catch(() => {
        if (payload.callId) {
          queueCallEndForReconnect(payload);
        }
      });
  }, [socket]);

  const emitLocalVideoState = (mediaState = {}, callSnapshot = null) => {
    const currentCall = callSnapshot || useAppStore.getState().activeCall;
    if (!currentCall) return;
    const to = currentCall.otherUserId || currentCall.callerId;
    if (!to || !currentCall.callId) return;
    const normalizedState = normalizeCallMediaState(
      typeof mediaState === "boolean" ? { videoOff: mediaState } : mediaState,
    );
    const mediaSeq = outgoingMediaSeqRef.current + 1;
    outgoingMediaSeqRef.current = mediaSeq;
    const payload = {
      to,
      callId: currentCall.callId,
      ...normalizedState,
      mediaSeq,
    };
    if (!socket?.connected) {
      queueCallMediaStateForReconnect(payload);
      return;
    }
    socket.emit("call:media-state", payload);
    window.setTimeout(() => {
      if (socket.connected) {
        socket.emit("call:media-state", payload);
      } else {
        queueCallMediaStateForReconnect(payload);
      }
    }, 180);
    window.setTimeout(() => {
      if (socket.connected) {
        socket.emit("call:media-state", payload);
      } else {
        queueCallMediaStateForReconnect(payload);
      }
    }, 700);
    lastMediaStateEmitAtRef.current = Date.now();
  };

  const startLocalVideoStateSync = (callSnapshot = null) => {
    clearLocalVideoStateSyncInterval();
    localVideoStateSyncIntervalRef.current = setInterval(async () => {
      if (callFinalizedRef.current || !nativeReadyRef.current) return;
      try {
        const state = await NativeCallPlugin.getLocalVideoState();
        const normalizedState = normalizeCallMediaState({
          videoOff: state?.isVideoOff,
          videoSource: state?.videoSource,
          screenShareActive: state?.screenShareActive,
        });
        const signature = getMediaStateSignature(normalizedState);
        const prev = lastBroadcastLocalMediaStateRef.current;
        if (prev === null) {
          lastBroadcastLocalMediaStateRef.current = signature;
          emitLocalVideoState(normalizedState, callSnapshot);
          return;
        }
        if (prev !== signature) {
          lastBroadcastLocalMediaStateRef.current = signature;
          emitLocalVideoState(normalizedState, callSnapshot);
          return;
        }
        if (Date.now() - lastMediaStateEmitAtRef.current >= MEDIA_STATE_RESYNC_MS) {
          emitLocalVideoState(normalizedState, callSnapshot);
        }
      } catch {
        // Best-effort sync only.
      }
    }, 1200);
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
      lastBroadcastLocalMediaStateRef.current = null;
      lastMediaStateEmitAtRef.current = 0;
      lastConnectionStateRef.current = "new";
      lastInactiveProbeAtRef.current = 0;
      outgoingMediaSeqRef.current = 0;
      latestIncomingMediaSeqRef.current = -1;
    clearLocalVideoStateSyncInterval();
    clearCallHeartbeatInterval();
    clearConnectionProbeTimeout();
      connectionProbeInFlightRef.current = false;
      clearAcceptRetryInterval();

      // Register socket signaling handlers immediately so early offer/ICE packets
      // are not dropped while native startup is in progress.
      const matchesCurrentCall = ({ from, callId } = {}) => {
        const expectedFrom = activeCall.otherUserId || activeCall.callerId;
        const incomingCallId = callId?.toString?.() || callId || "";
        const currentCallId = activeCall.callId?.toString?.() || activeCall.callId || "";
        const normalizedFrom = from?.toString?.() || from || "";
        const normalizedExpectedFrom =
          expectedFrom?.toString?.() || expectedFrom || "";

        if (incomingCallId && currentCallId && incomingCallId !== currentCallId) {
          return false;
        }
        if (
          normalizedFrom &&
          normalizedExpectedFrom &&
          normalizedFrom !== normalizedExpectedFrom
        ) {
          return false;
        }
        return true;
      };

      const matchesCallEnd = ({ from, callId } = {}) => {
        const currentCall = useAppStore.getState().activeCall;
        if (!currentCall) return false;
        const normalizedFrom = normalizeId(from);
        const normalizedExpectedFrom = normalizeId(
          currentCall.otherUserId || currentCall.callerId,
        );
        const incomingCallId = normalizeId(callId);
        const currentCallId = normalizeId(currentCall.callId);

        // If sender identity is present and matches the current peer, accept end.
        // This avoids missing remote hangup when callId drifts due races/reuse.
        if (normalizedFrom && normalizedExpectedFrom) {
          return normalizedFrom === normalizedExpectedFrom;
        }

        // Fallback to callId match when sender is not available.
        if (incomingCallId && currentCallId) {
          return incomingCallId === currentCallId;
        }

        // If payload lacks identifiers, still accept as authoritative remote end
        // because this event is emitted directly to the target participant.
        return !normalizedFrom && !incomingCallId;
      };

      const matchesMediaState = ({ from, callId } = {}) => {
        const expectedFrom = activeCall.otherUserId || activeCall.callerId;
        const normalizedFrom = from?.toString?.() || from || "";
        const normalizedExpectedFrom =
          expectedFrom?.toString?.() || expectedFrom || "";
        const incomingCallId = callId?.toString?.() || callId || "";
        const currentCallId = activeCall.callId?.toString?.() || activeCall.callId || "";

        // Prefer peer match for media-state updates to tolerate occasional callId drift.
        if (normalizedFrom && normalizedExpectedFrom) {
          return normalizedFrom === normalizedExpectedFrom;
        }

        if (incomingCallId && currentCallId) {
          return incomingCallId === currentCallId;
        }

        return false;
      };

      const onOffer = ({ description, from, callId }) => {
        if (!matchesCurrentCall({ from, callId })) return;
        if (!description?.sdp) return;
        remoteOfferSeenRef.current = true;
        clearAcceptRetryInterval();
        NativeCallPlugin.handleRemoteOffer({
          sdp: description.sdp,
          type: description.type,
        }).catch(() => { });
      };

      const onAnswer = ({ description, from, callId }) => {
        if (!matchesCurrentCall({ from, callId })) return;
        if (!description?.sdp) return;
        NativeCallPlugin.handleRemoteAnswer({ sdp: description.sdp }).catch(() => { });
      };

      const onCandidate = ({ candidate, from, callId }) => {
        if (!matchesCurrentCall({ from, callId })) return;
        if (!candidate?.candidate) return;
        NativeCallPlugin.addIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        }).catch(() => { });
      };

      const onCandidates = ({ candidates, from, callId }) => {
        if (!matchesCurrentCall({ from, callId })) return;
        if (!Array.isArray(candidates) || candidates.length === 0) return;
        NativeCallPlugin.addIceCandidates({ candidates }).catch(() => { });
      };

      const onEnd = ({ from, callId } = {}) => {
        if (!matchesCallEnd({ from, callId })) return;
        remoteEndInProgressRef.current = true;
        NativeCallPlugin.endCall({ notifyRemote: false }).catch(() => {
          remoteEndInProgressRef.current = false;
        });
        finalizeCallState();
      };

      const onMediaState = ({
        from,
        callId,
        videoOff,
        videoSource,
        screenShareActive,
        mediaSeq,
      } = {}) => {
        if (!matchesMediaState({ from, callId })) return;
        const parsedSeq = Number(mediaSeq);
        if (Number.isFinite(parsedSeq)) {
          if (parsedSeq <= latestIncomingMediaSeqRef.current) return;
          latestIncomingMediaSeqRef.current = parsedSeq;
        }
        const normalizedState = normalizeCallMediaState({
          videoOff,
          videoSource,
          screenShareActive,
        });
        console.info("[NativeCallHandler] socket call:media-state", {
          from,
          callId,
          raw: { videoOff, videoSource, screenShareActive, mediaSeq: parsedSeq },
          normalized: normalizedState,
        });
        NativeCallPlugin.setRemoteMediaState({
          videoOff: normalizedState.videoOff,
          videoSource: normalizedState.videoSource,
          screenShareActive: normalizedState.screenShareActive,
          mediaSeq: parsedSeq,
        }).catch(() => { });
      };

      socketHandlersRef.current = {
        onOffer,
        onAnswer,
        onCandidate,
        onCandidates,
        onEnd,
        onMediaState,
      };
      socket.on("call:offer", onOffer);
      socket.on("call:answer", onAnswer);
      socket.on("call:ice-candidate", onCandidate);
      socket.on("call:ice-candidates", onCandidates);
      socket.on("call:end", onEnd);
      socket.on("call:media-state", onMediaState);

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
            socket.emit("call:offer", {
              to,
              description: data,
              callId: activeCall.callId,
            });
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onLocalAnswer", (data) => {
            const to = activeCall.otherUserId || activeCall.callerId;
            socket.emit("call:answer", {
              to,
              description: data,
              callId: activeCall.callId,
            });
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onIceCandidates", (data) => {
            const to = activeCall.otherUserId || activeCall.callerId;
            socket.emit("call:ice-candidates", {
              to,
              candidates: data.candidates,
              callId: activeCall.callId,
            });
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onLocalVideoToggled", (data) => {
            const normalizedState = normalizeCallMediaState({
              videoOff: data?.isVideoOff,
              videoSource: data?.videoSource,
              screenShareActive: data?.screenShareActive,
            });
            lastBroadcastLocalMediaStateRef.current =
              getMediaStateSignature(normalizedState);
            emitLocalVideoState(normalizedState, activeCall);
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onRemoteControlEnd", () => {
            remoteEndInProgressRef.current = true;
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onConnectionStateChanged", (data) => {
            const state = (data?.state || "").toLowerCase();
            lastConnectionStateRef.current = state || "unknown";
            if (
              state === "connected" ||
              state === "completed" ||
              state === "checking"
            ) {
              clearConnectionProbeTimeout();
              connectionProbeInFlightRef.current = false;
              return;
            }
            if (state !== "failed") return;

            clearConnectionProbeTimeout();
            const probeDelayMs = 260;
            connectionProbeTimeoutRef.current = window.setTimeout(() => {
              if (callFinalizedRef.current || !socket) return;
              if (connectionProbeInFlightRef.current) return;
              if (
                lastConnectionStateRef.current !== "failed" &&
                lastConnectionStateRef.current !== "disconnected"
              ) {
                return;
              }
              const currentCall = useAppStore.getState().activeCall;
              const peerId = currentCall?.otherUserId || currentCall?.callerId;
              const callId = currentCall?.callId;
              if (!peerId || !callId) return;

              connectionProbeInFlightRef.current = true;
              const probeOnce = (onResult) => {
                let settled = false;
                const probeGuard = window.setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  onResult(true);
                }, 1500);

                socket.emit("call:is-active", { callId, peerId }, (result = {}) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(probeGuard);
                  onResult(Boolean(result.active));
                });
              };

              probeOnce((isActiveNow) => {
                if (isActiveNow) {
                  connectionProbeInFlightRef.current = false;
                  return;
                }

                const now = Date.now();
                if (now - lastInactiveProbeAtRef.current < 900) {
                  connectionProbeInFlightRef.current = false;
                  return;
                }
                lastInactiveProbeAtRef.current = now;

                window.setTimeout(() => {
                  if (callFinalizedRef.current || !socket) {
                    connectionProbeInFlightRef.current = false;
                    return;
                  }
                  if (
                    lastConnectionStateRef.current !== "failed" &&
                    lastConnectionStateRef.current !== "disconnected"
                  ) {
                    connectionProbeInFlightRef.current = false;
                    return;
                  }

                  probeOnce((isActiveConfirm) => {
                    connectionProbeInFlightRef.current = false;
                    if (callFinalizedRef.current) return;
                    if (isActiveConfirm) return;
                    if (
                      lastConnectionStateRef.current !== "failed" &&
                      lastConnectionStateRef.current !== "disconnected"
                    ) {
                      return;
                    }

                    remoteEndInProgressRef.current = true;
                    NativeCallPlugin.endCall({ notifyRemote: false }).catch(() => {
                      remoteEndInProgressRef.current = false;
                    });
                    finalizeCallState();
                  });
                }, 520);
              });
            }, probeDelayMs);
          }),
        );

        listenersRef.current.push(
          await NativeCallPlugin.addListener("onCallEnded", () => {
            const shouldNotifyRemote = !remoteEndInProgressRef.current;
            remoteEndInProgressRef.current = false;
            if (shouldNotifyRemote) {
              const to = activeCall.otherUserId || activeCall.callerId;
              emitCallEndReliable({ to, callId: activeCall.callId });
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
            emitCallEndReliable({
              to,
              callId: currentCall.callId,
              reason: "local_video_failure",
            });
            remoteEndInProgressRef.current = true;
            NativeCallPlugin.endCall({ reason: "local_video_failure" }).catch(() => {
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
            callId: activeCall.callId,
            peerId: activeCall.otherUserId || activeCall.callerId || "",
            apiBaseUrl: HOST,
            callStartedAt: activeCall.callStartedAt || undefined,
          });
          await NativeCallPlugin.setRemoteMediaState({
            videoOff: false,
            videoSource: "camera",
            screenShareActive: false,
          });
          try {
            const localVideoState = await NativeCallPlugin.getLocalVideoState();
            const normalizedState = normalizeCallMediaState({
              videoOff: localVideoState?.isVideoOff,
              videoSource: localVideoState?.videoSource,
              screenShareActive: localVideoState?.screenShareActive,
            });
            lastBroadcastLocalMediaStateRef.current =
              getMediaStateSignature(normalizedState);
            emitLocalVideoState(normalizedState, activeCall);
          } catch {
            lastBroadcastLocalMediaStateRef.current = null;
          }
          startLocalVideoStateSync(activeCall);
          nativeReadyRef.current = true;
          pipModeRef.current = false;
          callUiVisibleRef.current = true;
          setCallMinimized(false);
        } catch (startError) {
          console.error("Failed to start native call (permission denied or error):", startError);
          // If the user denied permissions, the plugin rejects. We must abort the call.
          alert(`Could not start call: ${startError.message || "Permissions denied"}`);
          const to = activeCall?.otherUserId || activeCall?.callerId;
          emitCallEndReliable({
            to,
            callId: activeCall?.callId,
            reason: "permission_denied",
          });
          await NativeCallPlugin.endCall({ reason: "permission_denied" }).catch(() => { });
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
      clearLocalVideoStateSyncInterval();
      clearCallHeartbeatInterval();
      clearConnectionProbeTimeout();
      connectionProbeInFlightRef.current = false;
      lastConnectionStateRef.current = "closed";
      lastInactiveProbeAtRef.current = 0;
      outgoingMediaSeqRef.current = 0;
      latestIncomingMediaSeqRef.current = -1;
      peerConnectionCreatingRef.current = false;
      remoteOfferSeenRef.current = false;
      localOfferSentRef.current = false;
      lastSyncedStartRef.current = 0;
      lastBroadcastLocalMediaStateRef.current = null;
      lastMediaStateEmitAtRef.current = 0;
      // Bug B fix: unregister with exact handler references so we don't accidentally
      // strip the global SocketContext listeners for these events.
      const h = socketHandlersRef.current;
      socket.off("call:offer", h.onOffer);
      socket.off("call:answer", h.onAnswer);
      socket.off("call:ice-candidate", h.onCandidate);
      socket.off("call:ice-candidates", h.onCandidates);
      socket.off("call:end", h.onEnd);
      socket.off("call:media-state", h.onMediaState);
      socketHandlersRef.current = {};
      initialized.current = false;

      // Crucial: When the React component unmounts (e.g., due to call-rejected clearing activeCall),
      // we must explicitly inform the Native plugin to destroy the CallActivity.
      NativeCallPlugin.endCall({ notifyRemote: false }).catch(() => { });
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
    emitCallEndReliable,
  ]);

  useEffect(() => {
    clearCallHeartbeatInterval();
    if (!socket || !activeCall?.callId) return;

    const emitHeartbeat = () => {
      if (!socket.connected) return;
      const currentCall = useAppStore.getState().activeCall;
      if (!currentCall?.callId) return;
      const peerId = currentCall.otherUserId || currentCall.callerId;
      socket.emit("call:heartbeat", {
        callId: currentCall.callId,
        ...(peerId ? { peerId } : {}),
      });
    };

    emitHeartbeat();
    callHeartbeatIntervalRef.current = setInterval(emitHeartbeat, 15000);

    return () => {
      clearCallHeartbeatInterval();
    };
  }, [socket, activeCall?.callId, activeCall?.otherUserId, activeCall?.callerId]);

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
        const h = socketHandlersRef.current;
        // Temporarily suppress our own onEnd handler so we don't double-finalize.
        if (h.onEnd) socket.off("call:end", h.onEnd);
        emitCallEndReliable({
          to,
          callId: activeCall?.callId,
          reason: "peer_connection_failed",
        });
        if (h.onEnd) socket.on("call:end", h.onEnd);
        await NativeCallPlugin.endCall({ reason: "peer_connection_failed" }).catch(() => { });
        finalizeCallState();
      }
    };

    createPC();
  }, [
    callAccepted,
    activeCall?.isCaller,
    activeCall?.callId,
    activeCall?.otherUserId,
    activeCall?.callerId,
    clearCallAccepted,
    emitCallEndReliable,
  ]);

  useEffect(() => {
    if (!activeCall?.callStartedAt) return;
    syncCallStartTimeToNative(activeCall.callStartedAt);
  }, [activeCall?.callStartedAt]);

  return null; // No UI — native Activity handles it
};

const CallContainer = () => {
  const { activeCall } = useAppStore();

  if (!activeCall) return null;
  if (!activeCall.callId) return null;

  // Native Capacitor: only video calls use native plugin.
  // Audio calls use the shared web component for parity across platforms.
  if (Capacitor.isNativePlatform() && activeCall.callType === "video") {
    return <NativeCallHandler />;
  }

  // Web + native-audio: shared React call components
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

