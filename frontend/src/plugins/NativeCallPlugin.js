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
   */
  async startCall({ callType, isCaller, otherUserName, otherUserImage = "" }) {
    return NativeWebRTC.startCall({ callType, isCaller, otherUserName, otherUserImage });
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

  /** Flip camera. Returns { facingMode: string } */
  async flipCamera() {
    return NativeWebRTC.flipCamera();
  },

  /** End the call and cleanup all resources. */
  async endCall() {
    return NativeWebRTC.endCall();
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
   *         onConnectionStateChanged, onCallEnded, onLocalVideoFailure, onPipModeChanged,
   *         onCallUiVisibilityChanged, onCallUiClosed
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
