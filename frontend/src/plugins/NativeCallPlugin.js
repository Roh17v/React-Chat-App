import { registerPlugin } from "@capacitor/core";

/**
 * Native WebRTC Capacitor Plugin
 *
 * Handles video/audio calls using native Android WebRTC (hardware encoder/decoder)
 * instead of the WebView's built-in WebRTC. Signaling stays in JS (Socket.IO).
 *
 * On web/non-native platforms, this plugin is not used — the existing
 * VideoCallScreen.jsx / AudioCallScreen.jsx handle calls via WebView WebRTC.
 */

const NativeWebRTC = registerPlugin("NativeWebRTC");

const NativeCallPlugin = {
  /**
   * Initialize the native WebRTC factory (hardware encoder/decoder).
   * Call this once before starting any calls.
   */
  async initialize() {
    return NativeWebRTC.initialize();
  },

  /**
   * Start a call — launches native CallActivity with video rendering.
   * @param {Object} options
   * @param {string} options.callType - "video" or "audio"
   * @param {boolean} options.isCaller - true if this user initiated the call
   * @param {string} options.otherUserName - display name of the other user
   * @param {string} [options.callId] - active call id for native finalize fallback
   * @param {string} [options.peerId] - remote user id for native finalize fallback
   * @param {string} [options.apiBaseUrl] - backend base url (e.g. https://api.example.com)
   * @param {number} [options.callStartedAt] - unix epoch ms
   */
  async startCall({
    callType,
    isCaller,
    otherUserName,
    otherUserImage = "",
    callId,
    peerId,
    apiBaseUrl,
    callStartedAt,
  }) {
    return NativeWebRTC.startCall({
      callType,
      isCaller,
      otherUserName,
      otherUserImage,
      callId,
      peerId,
      apiBaseUrl,
      callStartedAt,
    });
  },

  /**
   * Create PeerConnection with ICE servers (TURN/STUN).
   * @param {Object} options
   * @param {Array} options.iceServers - Array of { urls, username?, credential? }
   */
  async createPeerConnection({ iceServers }) {
    return NativeWebRTC.createPeerConnection({ iceServers });
  },

  /**
   * Caller-only nudge to start offer creation if onRenegotiationNeeded is delayed.
   * Returns { started: boolean, reason?: string }.
   */
  async kickstartOffer() {
    return NativeWebRTC.kickstartOffer();
  },

  /**
   * Handle a remote SDP offer (from call:offer socket event).
   */
  async handleRemoteOffer({ sdp, type = "offer" }) {
    return NativeWebRTC.handleRemoteOffer({ sdp, type });
  },

  /**
   * Handle a remote SDP answer (from call:answer socket event).
   */
  async handleRemoteAnswer({ sdp }) {
    return NativeWebRTC.handleRemoteAnswer({ sdp });
  },

  /**
   * Add a single ICE candidate (from call:ice-candidate socket event).
   */
  async addIceCandidate({ candidate, sdpMid, sdpMLineIndex }) {
    return NativeWebRTC.addIceCandidate({ candidate, sdpMid, sdpMLineIndex });
  },

  /**
   * Add batched ICE candidates (from call:ice-candidates socket event).
   */
  async addIceCandidates({ candidates }) {
    return NativeWebRTC.addIceCandidates({ candidates });
  },

  /** Toggle mute. Returns { isMuted: boolean } */
  async toggleMute() {
    return NativeWebRTC.toggleMute();
  },

  /** Toggle video. Returns { isVideoOff: boolean } */
  async toggleVideo() {
    return NativeWebRTC.toggleVideo();
  },

  /** Read current local camera state from native call engine. */
  async getLocalVideoState() {
    return NativeWebRTC.getLocalVideoState();
  },

  /** Update remote peer camera-off state for native UI placeholder. */
  async setRemoteVideoOff({ videoOff }) {
    return NativeWebRTC.setRemoteVideoOff({ videoOff });
  },

  /** Update remote peer media state for native UI rendering. */
  async setRemoteMediaState({
    videoOff,
    videoSource,
    screenShareActive,
    mediaSeq,
  }) {
    return NativeWebRTC.setRemoteMediaState({
      videoOff,
      videoSource,
      screenShareActive,
      ...(Number.isFinite(mediaSeq) ? { mediaSeq } : {}),
    });
  },

  /** Flip camera. Returns { facingMode: string } */
  async flipCamera() {
    return NativeWebRTC.flipCamera();
  },

  /** End the call and cleanup all resources. */
  async endCall({ notifyRemote = true, reason } = {}) {
    return NativeWebRTC.endCall({
      notifyRemote,
      ...(reason ? { reason } : {}),
    });
  },

  /**
   * Prepare Android call audio routing.
   * defaultRoute: "earpiece" | "speaker"
   */
  async setupAudioRouting({ defaultRoute = "earpiece" } = {}) {
    return NativeWebRTC.setupAudioRouting({ defaultRoute });
  },

  /** Toggle Android audio route between earpiece and loudspeaker. */
  async setSpeakerRoute({ enabled }) {
    return NativeWebRTC.setSpeakerRoute({ enabled });
  },

  /** Restore original Android audio route and mode. */
  async teardownAudioRouting() {
    return NativeWebRTC.teardownAudioRouting();
  },

  /**
   * Sync shared call start time (Unix epoch ms) so native timer matches web timer.
   */
  async syncCallStartTime({ callStartedAt }) {
    return NativeWebRTC.syncCallStartTime({ callStartedAt });
  },

  /**
   * Reopen native call Activity when it was dismissed from PiP.
   */
  async reopenCallActivity() {
    return NativeWebRTC.reopenCallActivity();
  },

  /**
   * Read authoritative native call UI state.
   * Returns: { isPip: boolean, isVisible: boolean, hasOngoingCall: boolean }
   */
  async getCallUiState() {
    return NativeWebRTC.getCallUiState();
  },

  /**
   * Add event listener for native plugin events.
   * Events: onLocalOffer, onLocalAnswer, onIceCandidates,
   *         onConnectionStateChanged, onCallEnded, onLocalVideoFailure, onLocalVideoToggled, onPipModeChanged,
   *         onCallUiVisibilityChanged, onCallUiClosed, onRemoteControlEnd
   */
  addListener(event, callback) {
    return NativeWebRTC.addListener(event, callback);
  },

  /** Remove all listeners for a specific event. */
  removeAllListeners(event) {
    return NativeWebRTC.removeAllListeners(event);
  },
};

export default NativeCallPlugin;
