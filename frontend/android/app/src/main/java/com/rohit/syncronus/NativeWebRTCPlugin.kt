package com.rohit.syncronus

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import android.view.WindowManager
import android.webkit.CookieManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.nio.ByteBuffer
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONObject
import org.webrtc.*
import java.util.Timer
import java.util.TimerTask

@CapacitorPlugin(
    name = "NativeWebRTC",
    permissions = [
        Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")
    ]
)
class NativeWebRTCPlugin : Plugin() {

    companion object {
        private const val TAG = "NativeWebRTC"
        // Stability-first cap for heterogeneous Android app-to-app calls.
        private const val MAX_VIDEO_BITRATE = 1_500_000 // 1.5 Mbps for smooth HD video/screen share
        private const val CAMERA_VIDEO_BITRATE = 800_000 // 800 kbps for standard camera video
        private const val ICE_BATCH_DELAY_MS = 100L
        private const val FREEZE_MONITOR_INTERVAL_MS = 2000L
        private const val FREEZE_DETECT_CONSECUTIVE_CHECKS = 2
        private const val REMOTE_RECOVERY_COOLDOWN_MS = 6000L
        private const val LOCAL_RECOVERY_COOLDOWN_MS = 8000L
        private const val UI_RESUME_RECOVERY_COOLDOWN_MS = 2500L
        private const val UI_RESUME_HEALTH_PROBE_DELAY_MS = 900L
        private const val DISCONNECT_FAILSAFE_MS = 12000L
        private const val FAILED_FAILSAFE_MS = 7000L
        private const val VIDEO_TOGGLE_MIN_INTERVAL_MS = 280L
        private const val CONTROL_DATA_CHANNEL_LABEL = "call-control"
        private const val NATIVE_FINALIZE_CONNECT_TIMEOUT_MS = 2500
        private const val NATIVE_FINALIZE_READ_TIMEOUT_MS = 3500
        var instance: NativeWebRTCPlugin? = null
            private set
    }

    // WebRTC core
    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var localStream: MediaStream? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    // Root Cause 1 fix: store AudioSource and VideoSource as class fields so they
    // can be explicitly disposed in cleanup(). In WebRTC Android, disposing a Track
    // does NOT cascade to its Source — each must be disposed separately. Without
    // this, every call leaks 2 native WebRTC media engine objects; after ~8-10 calls
    // native resource limits are hit and the next call fails to start media.
    private var localAudioSource: org.webrtc.AudioSource? = null
    private var localVideoSource: org.webrtc.VideoSource? = null
    private var screenVideoSource: org.webrtc.VideoSource? = null
    private var localVideoSender: RtpSender? = null
    private var remoteVideoTrack: VideoTrack? = null
    private var screenVideoTrack: VideoTrack? = null
    private var controlDataChannel: DataChannel? = null
    private var localControlChannelSeq: Long = 0L
    private var latestRemoteControlSeq: Long = -1L
    private var latestRemoteMediaStateSeq: Long = -1L
    private var latestRemoteSocketMediaStateSeq: Long = -1L
    private var videoCapturer: CameraVideoCapturer? = null
    private var screenVideoCapturer: ScreenCapturerAndroid? = null
    private var eglBase: EglBase? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var screenSurfaceTextureHelper: SurfaceTextureHelper? = null
    // Root Cause 2 fix: track camera release thread so startLocalMedia() can join
    // it before opening the camera, preventing CAMERA_IN_USE race conditions.
    @Volatile private var cameraReleaseThread: Thread? = null

    // ICE candidate batching
    private val candidateBuffer = mutableListOf<IceCandidate>()
    private var candidateTimer: Timer? = null
    private var connectionTimeout: Timer? = null
    private var disconnectFailsafeTimer: Timer? = null
    private var freezeMonitorTimer: Timer? = null
    private var lastInboundFramesDecoded: Long = -1L
    private var lastInboundBytesReceived: Long = -1L
    private var lastInboundAudioBytesReceived: Long = -1L
    private var consecutiveRemoteFreezeChecks = 0
    private var consecutiveRemoteVideoOffChecks = 0
    private var isRemoteVideoOffHeuristic = false
    private var lastRemoteRecoveryAtMs: Long = 0L
    private var remoteRecoveryEscalation = 0
    private var lastOutboundFramesSent: Long = -1L
    private var lastOutboundBytesSent: Long = -1L
    private var consecutiveLocalFreezeChecks = 0
    private var lastLocalRecoveryAtMs: Long = 0L
    private var localRecoveryEscalation = 0
    private var activeCaptureProfile: CaptureProfile? = null

    // State
    private var isMuted = false
    private var isVideoOff = false
    private var isRemoteVideoOff = false
    private var isRemoteScreenShareActive = false
    private var localVideoSourceMode = "camera"
    private var wasVideoOffBeforeScreenShare = false
    private var wasCameraCaptureSuspendedForScreenShare = false
    private var facingMode = "user" // "user" or "environment"
    private var isPolite = false
    private var makingOffer = false
    private var ignoreOffer = false
    var callActivityActive = false
    private var isInPipMode = false
    private var callStartTime: Long = 0L
    private var localStreamId: String = java.util.UUID.randomUUID().toString()
    private var activeCallType: String = "video"
    private var activeIsCaller: Boolean = false
    private var activeOtherUserName: String = "Unknown"
    private var activeOtherUserImage: String = ""
    private var activeCallId: String = ""
    private var activePeerId: String = ""
    private var activeApiBaseUrl: String = ""
    private var activeCallStartedAtEpochMs: Long = 0L
    private var nativeFinalizeAttempted: Boolean = false
    private var pendingControlMessage: String? = null
    private var lastUiResumeRecoveryAtMs: Long = 0L
    @Volatile private var uiResumeRecoverySeq: Long = 0L
    private var hasEverConnected: Boolean = false
    private var lastVideoToggleAtMs: Long = 0L
    @Volatile
    private var isCleaningUp = false
    // Native audio routing state for WebView-based audio calls (Capacitor audio screen).
    private var audioRoutingManager: AudioManager? = null
    private var audioRoutingPrepared = false
    private var originalAudioRoutingMode: Int = AudioManager.MODE_NORMAL
    private var originalAudioRoutingSpeakerphoneOn: Boolean = false
    private var originalAudioRoutingBluetoothScoOn: Boolean = false
    private var originalAudioRoutingCommunicationDeviceType: Int? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    // Bug C fix: single shared Runnable for remote-track attachment retries.
    // Keeping a class-level reference allows removeCallbacks() to cancel ALL
    // pending retries from previous attach attempts before scheduling new ones,
    // preventing concurrent duplicate sink add/remove races.
    @Volatile
    private var currentAttachRunnable: Runnable? = null
    private val attachHandler = android.os.Handler(android.os.Looper.getMainLooper())

    // Pending signaling (before PeerConnection is ready)
    private var pendingRemoteDescription: SessionDescription? = null
    private val pendingCandidates = mutableListOf<IceCandidate>()

    private data class VideoCapturerCandidate(
        val backend: String,
        val capturer: CameraVideoCapturer,
    )

    private data class CaptureProfile(
        val width: Int,
        val height: Int,
        val fps: Int,
    )

    private fun stableCaptureProfiles(): List<CaptureProfile> = listOf(
        CaptureProfile(480, 360, 20),
        CaptureProfile(640, 480, 20),
        CaptureProfile(320, 240, 15),
    )

    private fun buildScreenCaptureProfile(context: Context): CaptureProfile {
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        var width: Int
        var height: Int

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = windowManager.currentWindowMetrics.bounds
            width = bounds.width()
            height = bounds.height()
        } else {
            val metrics = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getRealMetrics(metrics)
            width = metrics.widthPixels
            height = metrics.heightPixels
        }

        // Smart Scaling: Cap resolution at 1280px (approx 720p) to maintain high FPS and low latency.
        // Screen sharing at full 1080p/1440p is too heavy for real-time mobile encoding.
        val maxDim = 1280
        if (width > maxDim || height > maxDim) {
            val scale = maxDim.toFloat() / maxOf(width, height)
            width = (width * scale).toInt()
            height = (height * scale).toInt()
        }

        // Hardware video encoders STRICTLY require dimensions to be multiples of 16 (or at least even).
        width = width - (width % 16)
        height = height - (height % 16)

        return CaptureProfile(width, height, 30)
    }

    fun canToggleScreenShareNative(): Boolean {
        if (activeCallType != "video" || isCleaningUp) return false
        if (isScreenShareActive()) return true
        return peerConnection != null &&
            localVideoSender != null &&
            eglBase?.eglBaseContext != null
    }

    fun getScreenShareUnavailableReason(): String {
        return when {
            activeCallType != "video" -> "Screen share is only available during video calls."
            isCleaningUp -> "Call is ending. Please try again in a new call."
            peerConnection == null || localVideoSender == null ->
                "Screen share will be available once the call finishes connecting."
            eglBase?.eglBaseContext == null ->
                "Screen share is still getting ready. Please try again in a moment."
            else -> "Screen share is not available right now."
        }
    }

    override fun load() {
        instance = this
        Log.d(TAG, "NativeWebRTC plugin loaded")
    }

    // ==================== LIFECYCLE ====================

    @PluginMethod
    fun initialize(call: PluginCall) {
        try {
            initializeWebRTC()
            call.resolve(JSObject().put("success", true))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize WebRTC", e)
            call.reject("Failed to initialize WebRTC: ${e.message}")
        }
    }

    @PluginMethod
    fun startCall(call: PluginCall) {
        val callType = call.getString("callType", "video") ?: "video"
        val isCaller = call.getBoolean("isCaller", false) ?: false
        val otherUserName = call.getString("otherUserName", "Unknown") ?: "Unknown"
        val otherUserImage = call.getString("otherUserImage", "") ?: ""
        val callId = call.getString("callId", "") ?: ""
        val peerId = call.getString("peerId", "") ?: ""
        val apiBaseUrl = call.getString("apiBaseUrl", "") ?: ""
        val callStartedAt = call.getLong("callStartedAt") ?: 0L

        isPolite = !isCaller
        activeCallType = callType
        activeIsCaller = isCaller
        activeOtherUserName = otherUserName
        activeOtherUserImage = otherUserImage
        activeCallId = callId
        activePeerId = peerId
        activeApiBaseUrl = apiBaseUrl.trim().trimEnd('/')
        activeCallStartedAtEpochMs = if (callStartedAt > 0L) callStartedAt else 0L
        nativeFinalizeAttempted = false
        hasEverConnected = false

        if (getPermissionState("camera") != com.getcapacitor.PermissionState.GRANTED ||
            getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            
            // Save the call to resolve it after permission request
            saveCall(call)
            
            val aliases = if (callType == "video") arrayOf("camera", "microphone") else arrayOf("microphone")
            requestPermissionForAliases(aliases, call, "permissionsCallback")
            return
        }

        executeStartCall(call)
    }

    @com.getcapacitor.annotation.PermissionCallback
    fun permissionsCallback(call: PluginCall) {
        val callType = call.getString("callType", "video") ?: "video"
        
        val micGranted = getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED
        val camGranted = getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED

        if (!micGranted) {
            call.reject("Microphone permission is required for calls")
            return
        }
        if (callType == "video" && !camGranted) {
            Log.w(TAG, "Camera permission denied by user; video will not work")
            // We can optionally proceed as audio-only or reject. Rejecting is safer for UX.
            call.reject("Camera permission is required for video calls")
            return
        }

        executeStartCall(call)
    }

    private fun executeStartCall(call: PluginCall) {
        try {
            if (peerConnectionFactory == null) {
                initializeWebRTC()
            }
            val mediaReady = startLocalMedia(activeCallType == "video")
            if (activeCallType == "video" && !mediaReady) {
                releasePreparedLocalMedia()
                call.reject("Failed to start local camera for video call")
                return
            }

            val launched = launchCallActivity(activeCallType, activeIsCaller, activeOtherUserName, activeOtherUserImage)
            if (!launched) {
                releasePreparedLocalMedia()
                call.reject("Unable to open call screen")
                return
            }

            call.resolve(JSObject().put("success", true))
        } catch (e: Exception) {
            releasePreparedLocalMedia()
            Log.e(TAG, "Failed to start call", e)
            call.reject("Failed to start call: ${e.message}")
        }
    }

    @PluginMethod
    fun endCall(call: PluginCall) {
        val notifyRemote = call.getBoolean("notifyRemote", true) ?: true
        val reason = call.getString("reason", if (notifyRemote) "hangup" else "remote_end")
            ?: if (notifyRemote) "hangup" else "remote_end"
        if (notifyRemote) {
            sendCallEndViaDataChannel("hangup")
        }
        cleanup(reason)
        call.resolve(JSObject().put("success", true))
    }

    @PluginMethod
    fun reopenCallActivity(call: PluginCall) {
        if (!hasOngoingCall()) {
            call.reject("No active call to reopen")
            return
        }

        val launched = launchCallActivity(activeCallType, activeIsCaller, activeOtherUserName, activeOtherUserImage)
        if (!launched) {
            call.reject("Unable to reopen call screen")
            return
        }
        call.resolve(JSObject().put("success", true))
    }

    private fun launchCallActivity(
        callType: String,
        isCaller: Boolean,
        otherUserName: String,
        otherUserImage: String = ""
    ): Boolean {
        val hostActivity = activity ?: return false

        val intent = android.content.Intent(hostActivity, CallActivity::class.java).apply {
            flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                    android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            putExtra("callType", callType)
            putExtra("isCaller", isCaller)
            putExtra("otherUserName", otherUserName)
            putExtra("otherUserImage", otherUserImage)
        }
        hostActivity.runOnUiThread {
            hostActivity.startActivity(intent)
            callActivityActive = true
        }
        return true
    }

    // ==================== ICE SERVERS & PEER CONNECTION ====================

    @PluginMethod
    fun createPeerConnection(call: PluginCall) {
        if (peerConnection != null) {
            Log.w(TAG, "createPeerConnection ignored: existing PeerConnection already active")
            call.resolve(
                JSObject()
                    .put("success", true)
                    .put("alreadyActive", true),
            )
            return
        }

        if (peerConnectionFactory == null) {
            call.reject("WebRTC is not initialized")
            return
        }

        // Fixed guard: use OR so that missing *either* track is caught, not only when both are null.
        // Previous AND logic let through partial failures (e.g. audio OK but video null)
        // creating a PeerConnection with a missing sender → black/silent call.
        if (activeCallType == "video" && (localAudioTrack == null || localVideoTrack == null)) {
            call.reject("Local media is not ready for video call")
            return
        }
        if (activeCallType != "video" && localAudioTrack == null) {
            call.reject("Local media is not ready for audio call")
            return
        }

        val iceServersArray = call.getArray("iceServers", JSArray())
        val iceServers = mutableListOf<PeerConnection.IceServer>()

        for (i in 0 until (iceServersArray?.length() ?: 0)) {
            try {
                val server = iceServersArray?.getJSONObject(i) ?: continue
                val urlsObj = server.opt("urls") ?: server.opt("url")

                val urls = mutableListOf<String>()
                if (urlsObj is org.json.JSONArray) {
                    for (j in 0 until urlsObj.length()) {
                        urls.add(urlsObj.getString(j))
                    }
                } else if (urlsObj is String) {
                    urls.add(urlsObj)
                }

                if (urls.isEmpty()) continue

                val builder = PeerConnection.IceServer.builder(urls)
                server.optString("username").takeIf { it.isNotEmpty() }?.let { builder.setUsername(it) }
                server.optString("credential").takeIf { it.isNotEmpty() }?.let { builder.setPassword(it) }
                iceServers.add(builder.createIceServer())
            } catch (e: Exception) {
                Log.w(TAG, "Failed to parse ICE server", e)
            }
        }

        if (iceServers.isEmpty()) {
            iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
            iceServers.add(PeerConnection.IceServer.builder("stun:global.stun.twilio.com:3478").createIceServer())
        }

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        peerConnection = peerConnectionFactory?.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                synchronized(candidateBuffer) {
                    candidateBuffer.add(candidate)
                    candidateTimer?.cancel()
                    candidateTimer = Timer().apply {
                        schedule(object : TimerTask() {
                            override fun run() { flushIceCandidates() }
                        }, ICE_BATCH_DELAY_MS)
                    }
                }
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                Log.d(TAG, "ICE connection state: $state")

                connectionTimeout?.cancel()
                connectionTimeout = null

                val jsState = when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        hasEverConnected = true
                        clearDisconnectFailsafeTimer()
                        // NOTE: callStartTime is intentionally NOT set here from local elapsedRealtime.
                        // ICE CONNECTED fires 3-4 seconds before the server's "call-connected" socket
                        // event arrives (which carries the authoritative connectedAt epoch from the DB).
                        // Setting it here would make the Chronometer start counting from the wrong base.
                        // syncCallStartTime() (called from the JS layer on "call-connected") is the
                        // sole writer. The CallActivity fallback (SystemClock.elapsedRealtime()) covers
                        // the rare edge case where call-connected never arrives.
                        applyBitrateCap()
                        startRemoteFreezeMonitor()
                        tryAttachRemoteTrackFromPeerConnection()
                        "connected"
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> {
                        stopRemoteFreezeMonitor()
                        if (hasEverConnected) {
                            scheduleDisconnectFailsafe(
                                DISCONNECT_FAILSAFE_MS,
                                "ice_disconnected_timeout",
                            )
                        }
                        connectionTimeout = Timer().apply {
                            schedule(object : TimerTask() {
                                override fun run() {
                                    if (peerConnection?.iceConnectionState() == PeerConnection.IceConnectionState.DISCONNECTED) {
                                        Log.d(TAG, "Triggering ICE restart after 2s disconnect delay")
                                        safeRestartIce("disconnect_timeout")
                                    }
                                }
                            }, 2000L)
                        }
                        "disconnected"
                    }
                    PeerConnection.IceConnectionState.FAILED -> {
                        stopRemoteFreezeMonitor()
                        if (hasEverConnected) {
                            scheduleDisconnectFailsafe(
                                FAILED_FAILSAFE_MS,
                                "ice_failed_timeout",
                            )
                        }
                        Log.d(TAG, "ICE Connection FAILED. Restarting ICE.")
                        safeRestartIce("ice_failed")
                        "failed"
                    }
                    PeerConnection.IceConnectionState.CLOSED -> {
                        clearDisconnectFailsafeTimer()
                        stopRemoteFreezeMonitor()
                        "closed"
                    }
                    else -> state.name.lowercase()
                }
                notifyListeners("onConnectionStateChanged", JSObject().put("state", jsState))
                // Also notify CallActivity
                CallActivity.instance?.onConnectionStateChanged(jsState)
            }

            // onAddStream is required by the PeerConnection.Observer interface but intentionally
            // left empty. We use UNIFIED_PLAN (SdpSemantics.UNIFIED_PLAN), where onTrack is the
            // canonical callback for incoming media tracks. Processing tracks in BOTH onAddStream
            // AND onTrack causes attachRemoteVideoTrack to fire twice for the same stream:
            // the second call removes and re-adds the SurfaceViewRenderer sink, which can
            // leave the renderer unable to display frames on certain Android devices (black screen).
            // onTrack alone is sufficient and correct for UNIFIED_PLAN.
            override fun onAddStream(stream: MediaStream) { /* no-op: see comment above */ }

            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track()
                if (track is VideoTrack) {
                    try {
                        attachRemoteVideoTrack(track)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to attach remote video track in onTrack", e)
                    }
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) {
                Log.d(TAG, "Signaling state: $state")
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: DataChannel) {
                attachControlDataChannel(channel)
            }
            override fun onRenegotiationNeeded() {
                // Native can emit renegotiation on both peers while initial setup is still racing.
                // To avoid startup glare/offer ping-pong, callee (polite peer) should not create
                // the very first offer before it has applied a remote description.
                val pc = peerConnection
                if (isPolite && pc?.remoteDescription == null) {
                    Log.d(TAG, "Skip early polite renegotiation before remote offer is applied")
                    return
                }
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    createAndSendOffer()
                }
            }
        })

        if (peerConnection == null) {
            call.reject("Failed to create PeerConnection")
            return
        }

        ensureControlDataChannelForCaller()

        // Add local tracks with a unique dynamically generated stream ID (prevents App-to-App collision dropping)
        localAudioTrack?.let { peerConnection?.addTrack(it, listOf(localStreamId)) }
        localVideoSender = localVideoTrack?.let { peerConnection?.addTrack(it, listOf(localStreamId)) }
        applyLocalVideoSendState()
        CallActivity.instance?.syncLocalVideoUiState()

        // Process any pending remote description
        pendingRemoteDescription?.let { desc ->
            handleRemoteDescriptionInternal(desc)
            pendingRemoteDescription = null
        }

        // The async onSetSuccess of handleRemoteDescriptionInternal will automatically
        // process any pendingCandidates when the PeerConnection is actually ready to accept them.

        call.resolve(JSObject().put("success", true))
    }

    @PluginMethod
    fun kickstartOffer(call: PluginCall) {
        if (isPolite) {
            call.resolve(
                JSObject()
                    .put("started", false)
                    .put("reason", "polite_peer"),
            )
            return
        }

        val pc = peerConnection
        if (pc == null) {
            call.resolve(
                JSObject()
                    .put("started", false)
                    .put("reason", "no_peer_connection"),
            )
            return
        }

        if (makingOffer) {
            call.resolve(
                JSObject()
                    .put("started", false)
                    .put("reason", "offer_in_progress"),
            )
            return
        }

        if (pc.localDescription != null) {
            call.resolve(
                JSObject()
                    .put("started", false)
                    .put("reason", "local_description_exists"),
            )
            return
        }

        if (pc.signalingState() != PeerConnection.SignalingState.STABLE) {
            call.resolve(
                JSObject()
                    .put("started", false)
                    .put("reason", "signaling_not_stable"),
            )
            return
        }

        android.os.Handler(android.os.Looper.getMainLooper()).post {
            createAndSendOffer()
        }

        call.resolve(JSObject().put("started", true))
    }

    // ==================== SIGNALING ====================

    @PluginMethod
    fun handleRemoteOffer(call: PluginCall) {
        val sdp = call.getString("sdp") ?: return call.reject("Missing SDP")
        val type = call.getString("type", "offer") ?: "offer"
        val desc = SessionDescription(
            if (type == "offer") SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER,
            sdp
        )

        if (peerConnection == null) {
            pendingRemoteDescription = desc
            call.resolve(JSObject().put("pending", true))
            return
        }

        handleRemoteDescriptionInternal(desc)
        call.resolve(JSObject().put("success", true))
    }

    @PluginMethod
    fun handleRemoteAnswer(call: PluginCall) {
        val sdp = call.getString("sdp") ?: return call.reject("Missing SDP")
        val desc = SessionDescription(SessionDescription.Type.ANSWER, sdp)

        if (peerConnection == null) {
            pendingRemoteDescription = desc
            call.resolve(JSObject().put("pending", true))
            return
        }

        handleRemoteDescriptionInternal(desc)

        call.resolve(JSObject().put("success", true))
    }

    @PluginMethod
    fun addIceCandidate(call: PluginCall) {
        val candidateStr = call.getString("candidate") ?: return call.reject("Missing candidate")
        val sdpMid = call.getString("sdpMid") ?: ""
        val sdpMLineIndex = call.getInt("sdpMLineIndex", 0) ?: 0
        val candidate = IceCandidate(sdpMid, sdpMLineIndex, candidateStr)

        val pc = peerConnection
        if (pc == null) {
            synchronized(pendingCandidates) {
                pendingCandidates.add(candidate)
            }
            call.resolve(JSObject().put("success", true).put("pending", true))
            return
        }

        if (ignoreOffer) {
            call.resolve(JSObject().put("success", true).put("ignored", true))
            return
        }

        if (pc.remoteDescription != null) {
            safeAddIceCandidate(pc, candidate)
        } else {
            synchronized(pendingCandidates) {
                pendingCandidates.add(candidate)
            }
        }
        call.resolve(JSObject().put("success", true))
    }

    @PluginMethod
    fun addIceCandidates(call: PluginCall) {
        val candidatesArray = call.getArray("candidates") ?: return call.reject("Missing candidates")

        val pc = peerConnection
        if (pc == null) {
            for (i in 0 until candidatesArray.length()) {
                try {
                    val obj = candidatesArray.getJSONObject(i)
                    val candidate = IceCandidate(
                        obj.optString("sdpMid", ""),
                        obj.optInt("sdpMLineIndex", 0),
                        obj.getString("candidate")
                    )
                    synchronized(pendingCandidates) {
                        pendingCandidates.add(candidate)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to parse ICE candidate", e)
                }
            }
            call.resolve(JSObject().put("success", true).put("pending", true))
            return
        }

        if (ignoreOffer) {
            call.resolve(JSObject().put("success", true).put("ignored", true))
            return
        }

        for (i in 0 until candidatesArray.length()) {
            try {
                val obj = candidatesArray.getJSONObject(i)
                val candidate = IceCandidate(
                    obj.optString("sdpMid", ""),
                    obj.optInt("sdpMLineIndex", 0),
                    obj.getString("candidate")
                )
                if (pc.remoteDescription != null) {
                    safeAddIceCandidate(pc, candidate)
                } else {
                    synchronized(pendingCandidates) {
                        pendingCandidates.add(candidate)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to parse ICE candidate", e)
            }
        }
        call.resolve(JSObject().put("success", true))
    }

    // ==================== MEDIA CONTROLS ====================

    fun toggleMuteNative() {
        isMuted = !isMuted
        localAudioTrack?.setEnabled(!isMuted)
    }

    private fun shouldThrottleVideoToggle(): Boolean {
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastVideoToggleAtMs < VIDEO_TOGGLE_MIN_INTERVAL_MS) {
            return true
        }
        lastVideoToggleAtMs = now
        return false
    }

    fun toggleVideoNative() {
        if (shouldThrottleVideoToggle()) return
        isVideoOff = !isVideoOff
        applyLocalVideoSendState()
        sendVideoStateViaDataChannel()
        notifyListeners("onLocalVideoToggled", buildLocalVideoStatePayload())
    }

    fun isVideoOffState(): Boolean = isVideoOff

    fun setRemoteVideoOffNative(videoOff: Boolean) {
        setRemoteMediaStateNative(videoOff = videoOff, source = "legacy_video_off")
    }

    fun isRemoteVideoOffState(): Boolean = isRemoteVideoOff
    fun isRemoteScreenShareActiveState(): Boolean = isRemoteScreenShareActive

    fun setRemoteMediaStateNative(
        videoOff: Boolean,
        videoSource: String? = null,
        screenShareActive: Boolean = false,
        mediaSeq: Long? = null,
        source: String = "unknown",
    ) {
        val shouldTrackSocketSequence =
            source == "plugin_call" || source == "socket" || source == "legacy_video_off"
        if (shouldTrackSocketSequence && mediaSeq != null && mediaSeq >= 0L) {
            if (mediaSeq < latestRemoteSocketMediaStateSeq) {
                Log.d(
                    TAG,
                    "Ignoring stale remote socket media state from $source (seq=$mediaSeq < latest=$latestRemoteSocketMediaStateSeq)",
                )
                return
            }
            latestRemoteSocketMediaStateSeq = mediaSeq
        }
        if (mediaSeq != null && mediaSeq >= 0L) {
            latestRemoteMediaStateSeq = maxOf(latestRemoteMediaStateSeq, mediaSeq)
        }

        val normalizedVideoSource = videoSource?.trim()?.lowercase()
        val resolvedScreenShareActive =
            !videoOff &&
                (screenShareActive || normalizedVideoSource == "screen")

        val videoOffChanged = isRemoteVideoOff != videoOff
        val screenShareChanged = isRemoteScreenShareActive != resolvedScreenShareActive

        isRemoteVideoOff = videoOff
        isRemoteScreenShareActive = resolvedScreenShareActive
        
        if (videoOffChanged) {
            CallActivity.instance?.setRemoteVideoOffState(videoOff)
        }
        if (screenShareChanged) {
            CallActivity.instance?.setRemoteScreenShareState(resolvedScreenShareActive)
        }
    }

    fun isFrontFacingCamera(): Boolean = facingMode == "user"

    private fun attachControlDataChannel(channel: DataChannel) {
        if (channel.label() != CONTROL_DATA_CHANNEL_LABEL) return
        if (controlDataChannel === channel) return

        controlDataChannel?.let { existing ->
            try {
                existing.unregisterObserver()
            } catch (_: Exception) {
            }
            try {
                existing.close()
            } catch (_: Exception) {
            }
            try {
                existing.dispose()
            } catch (_: Exception) {
            }
        }

        controlDataChannel = channel
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}

            override fun onStateChange() {
                val state = channel.state()
                Log.d(TAG, "Control DataChannel state: $state")
                if (state == DataChannel.State.OPEN) {
                    flushPendingControlMessage()
                    sendVideoStateViaDataChannel()
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                try {
                    val data = buffer.data
                    val bytes = ByteArray(data.remaining())
                    data.get(bytes)
                    val payload = String(bytes, Charsets.UTF_8)
                    val obj = JSONObject(payload)
                    when (obj.optString("type")) {
                        "video_state" -> {
                            val remoteSeq = if (obj.has("seq")) obj.optLong("seq", -1L) else -1L
                            if (remoteSeq >= 0L && remoteSeq <= latestRemoteControlSeq) {
                                return
                            }
                            if (remoteSeq >= 0L) {
                                latestRemoteControlSeq = remoteSeq
                            }
                            Log.d(
                                TAG,
                                "Received remote media state via DataChannel: videoOff=${obj.optBoolean("videoOff", false)}, videoSource=${obj.optString("videoSource", "")}, screenShareActive=${obj.optBoolean("screenShareActive", false)}, seq=$remoteSeq",
                            )
                            setRemoteMediaStateNative(
                                videoOff = obj.optBoolean("videoOff", false),
                                videoSource = obj.optString("videoSource", ""),
                                screenShareActive = obj.optBoolean("screenShareActive", false),
                                mediaSeq = if (remoteSeq >= 0L) remoteSeq else null,
                                source = "data_channel",
                            )
                        }
                        "call_end" -> {
                            notifyListeners(
                                "onRemoteControlEnd",
                                JSObject().put("reason", obj.optString("reason", "remote_end")),
                            )
                            android.os.Handler(android.os.Looper.getMainLooper()).post {
                                if (!isCleaningUp) {
                                    cleanup("remote_end")
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Failed parsing control DataChannel message", e)
                }
            }
        })

        if (channel.state() == DataChannel.State.OPEN) {
            flushPendingControlMessage()
            sendVideoStateViaDataChannel()
        }
    }

    private fun ensureControlDataChannelForCaller() {
        if (activeCallType != "video" || !activeIsCaller) return
        if (controlDataChannel != null) return
        val pc = peerConnection ?: return
        try {
            val init = DataChannel.Init().apply {
                ordered = true
            }
            val channel = pc.createDataChannel(CONTROL_DATA_CHANNEL_LABEL, init)
            attachControlDataChannel(channel)
        } catch (e: Exception) {
            Log.w(TAG, "Failed creating control DataChannel", e)
        }
    }

    private fun flushPendingControlMessage() {
        val channel = controlDataChannel ?: return
        if (channel.state() != DataChannel.State.OPEN) return
        val pending = pendingControlMessage ?: return
        try {
            channel.send(
                DataChannel.Buffer(
                    ByteBuffer.wrap(pending.toByteArray(Charsets.UTF_8)),
                    false,
                ),
            )
            pendingControlMessage = null
        } catch (e: Exception) {
            Log.w(TAG, "Failed flushing pending control DataChannel message", e)
        }
    }

    private fun buildLocalVideoStatePayload(): JSObject {
        val resolvedVideoSource = when {
            isVideoOff -> "off"
            localVideoSourceMode == "screen" -> "screen"
            else -> "camera"
        }
        return JSObject()
            .put("isVideoOff", isVideoOff)
            .put("videoOff", isVideoOff)
            .put("videoSource", resolvedVideoSource)
            .put("screenShareActive", resolvedVideoSource == "screen")
    }

    private fun isScreenShareActive(): Boolean =
        localVideoSourceMode == "screen" && screenVideoTrack != null

    private fun getActiveLocalVideoTrack(): VideoTrack? =
        if (isScreenShareActive()) screenVideoTrack else localVideoTrack

    private fun sendVideoStateViaDataChannel() {
        if (activeCallType != "video") return
        val resolvedVideoSource = when {
            isVideoOff -> "off"
            localVideoSourceMode == "screen" -> "screen"
            else -> "camera"
        }
        val payload = JSONObject().apply {
            put("type", "video_state")
            put("videoOff", isVideoOff)
            put("videoSource", resolvedVideoSource)
            put("screenShareActive", resolvedVideoSource == "screen")
            put("seq", ++localControlChannelSeq)
        }.toString()

        val channel = controlDataChannel
        if (channel == null || channel.state() != DataChannel.State.OPEN) {
            pendingControlMessage = payload
            return
        }

        try {
            channel.send(
                DataChannel.Buffer(
                    ByteBuffer.wrap(payload.toByteArray(Charsets.UTF_8)),
                    false,
                ),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed sending control DataChannel message", e)
            pendingControlMessage = payload
        }
    }

    private fun sendCallEndViaDataChannel(reason: String = "hangup") {
        if (activeCallType != "video") return
        val payload = JSONObject().apply {
            put("type", "call_end")
            put("reason", reason)
            put("seq", ++localControlChannelSeq)
        }.toString()

        val channel = controlDataChannel
        if (channel == null || channel.state() != DataChannel.State.OPEN) {
            pendingControlMessage = payload
            return
        }

        try {
            channel.send(
                DataChannel.Buffer(
                    ByteBuffer.wrap(payload.toByteArray(Charsets.UTF_8)),
                    false,
                ),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed sending call_end over control DataChannel", e)
            pendingControlMessage = payload
        }
    }

    fun flipCameraNative() {
        val capturer = videoCapturer ?: return
        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                facingMode = if (isFront) "user" else "environment"
                CallActivity.instance?.refreshRendererMirroring()
            }
            override fun onCameraSwitchError(error: String?) {}
        })
    }


    fun endCallNative() {
        sendCallEndViaDataChannel("hangup")
        cleanup("hangup")
    }

    fun notifyPipModeChange(isPip: Boolean) {
        isInPipMode = isPip
        notifyListeners("onPipModeChanged", JSObject().put("isPip", isPip))
    }

    fun notifyCallUiVisibility(isVisible: Boolean) {
        callActivityActive = isVisible
        if (!isVisible) {
            // Prevent stale delayed attach jobs from firing after PiP-dismiss/banner flows.
            currentAttachRunnable?.let { attachHandler.removeCallbacks(it) }
            currentAttachRunnable = null
            stopRemoteFreezeMonitor()
        } else if (isPeerConnected()) {
            startRemoteFreezeMonitor()
        }
        if (hasOngoingCall()) {
            notifyListeners("onCallUiVisibilityChanged", JSObject().put("isVisible", isVisible))
        }
    }

    fun recoverVideoAfterUiResume(pausedForMs: Long) {
        if (pausedForMs < 1200L) return
        if (isCleaningUp || activeCallType != "video" || isVideoOff) return
        if (localVideoSourceMode == "screen") return
        val pc = peerConnection ?: return
        val state = pc.iceConnectionState()
        if (state == PeerConnection.IceConnectionState.CLOSED ||
            state == PeerConnection.IceConnectionState.FAILED
        ) {
            return
        }

        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastUiResumeRecoveryAtMs < UI_RESUME_RECOVERY_COOLDOWN_MS) return
        lastUiResumeRecoveryAtMs = now
        val recoverySeq = ++uiResumeRecoverySeq

        android.os.Handler(android.os.Looper.getMainLooper()).post {
            if (isCleaningUp || activeCallType != "video" || isVideoOff) return@post
            try {
                // Fast path: re-assert sender wiring and renderer binding first.
                // This avoids unnecessary camera restart on normal PiP/fullscreen transitions.
                applyLocalVideoSendState()
                localVideoTrack?.let { CallActivity.instance?.setLocalVideoTrack(it) }
                if (callActivityActive) {
                    refreshRemoteTrackAttachment()
                }

                // Slow path: only restart camera if outbound video is truly stalled.
                val probePc = peerConnection
                val probeState = probePc?.iceConnectionState()
                val shouldProbe =
                    probeState == PeerConnection.IceConnectionState.CONNECTED ||
                        probeState == PeerConnection.IceConnectionState.COMPLETED
                if (!shouldProbe) {
                    return@post
                }
                collectOutboundVideoStats { firstFrames, firstBytes ->
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        if (recoverySeq != uiResumeRecoverySeq) return@postDelayed
                        if (isCleaningUp || activeCallType != "video" || isVideoOff) return@postDelayed
                        val latestPc = peerConnection
                        val latestState = latestPc?.iceConnectionState()
                        val stillConnected =
                            latestState == PeerConnection.IceConnectionState.CONNECTED ||
                                latestState == PeerConnection.IceConnectionState.COMPLETED
                        if (!stillConnected) return@postDelayed

                        collectOutboundVideoStats { latestFrames, latestBytes ->
                            val hasComparableSamples =
                                (firstFrames != null && latestFrames != null) ||
                                    (firstBytes != null && latestBytes != null)
                            if (!hasComparableSamples) {
                                // Stats are missing/unreliable on this device path; avoid false restarts.
                                return@collectOutboundVideoStats
                            }
                            val hasProgress =
                                (firstFrames != null && latestFrames != null && latestFrames > firstFrames) ||
                                (firstBytes != null && latestBytes != null && latestBytes > firstBytes)
                            if (hasProgress) {
                                return@collectOutboundVideoStats
                            }

                            try {
                                Log.w(
                                    TAG,
                                    "Outbound video appears stalled after resume; restarting local capture."
                                )
                                restartLocalVideoCapture()
                                localVideoTrack?.let {
                                    CallActivity.instance?.setLocalVideoTrack(it)
                                }
                                if (callActivityActive) {
                                    refreshRemoteTrackAttachment()
                                }
                            } catch (restartError: Exception) {
                                Log.w(TAG, "Resume stall recovery restart failed", restartError)
                            }
                        }
                    }, UI_RESUME_HEALTH_PROBE_DELAY_MS)
                }
            } catch (e: Exception) {
                Log.w(TAG, "recoverVideoAfterUiResume failed", e)
            }
        }
    }

    private fun collectOutboundVideoStats(onResult: (Long?, Long?) -> Unit) {
        val pc = peerConnection
        if (pc == null || isCleaningUp) {
            onResult(null, null)
            return
        }
        try {
            pc.getStats { report ->
                var framesSent: Long? = null
                var bytesSent: Long? = null

                report.statsMap.values.forEach { stats ->
                    if (stats.type != "outbound-rtp") return@forEach
                    val kind = (stats.members["kind"] as? String)?.lowercase()
                    val mediaType = (stats.members["mediaType"] as? String)?.lowercase()
                    val isVideo =
                        kind == "video" ||
                            mediaType == "video" ||
                            stats.id.contains("video", ignoreCase = true)
                    if (!isVideo) return@forEach

                    framesSent =
                        parseStatLong(stats.members["framesSent"])
                            ?: parseStatLong(stats.members["framesEncoded"])
                    bytesSent = parseStatLong(stats.members["bytesSent"])
                }

                onResult(framesSent, bytesSent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "collectOutboundVideoStats failed", e)
            onResult(null, null)
        }
    }

    fun onCallUiClosed() {
        notifyCallUiVisibility(false)
        if (hasOngoingCall()) {
            notifyListeners("onCallUiClosed", JSObject())
        }
    }

    private fun notifyLocalVideoFailure(reason: String, details: String = "") {
        notifyListeners(
            "onLocalVideoFailure",
            JSObject()
                .put("reason", reason)
                .put("details", details)
                .put("callType", activeCallType),
        )
    }

    @PluginMethod
    fun getCallUiState(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("isPip", isInPipMode)
                .put("isVisible", callActivityActive)
                .put("hasOngoingCall", hasOngoingCall()),
        )
    }

    @PluginMethod
    fun syncCallStartTime(call: PluginCall) {
        val callStartedAt = call.getLong("callStartedAt")
        if (callStartedAt == null || callStartedAt <= 0L) {
            call.reject("Missing or invalid callStartedAt")
            return
        }

        val elapsedSinceStart = maxOf(0L, System.currentTimeMillis() - callStartedAt)
        callStartTime = android.os.SystemClock.elapsedRealtime() - elapsedSinceStart
        activeCallStartedAtEpochMs = callStartedAt
        CallActivity.instance?.syncTimerBase(callStartTime)

        call.resolve(JSObject().put("callStartTime", callStartTime))
    }

    @PluginMethod
    fun toggleMute(call: PluginCall) {
        isMuted = !isMuted
        localAudioTrack?.setEnabled(!isMuted)
        call.resolve(JSObject().put("isMuted", isMuted))
    }

    @PluginMethod
    fun toggleVideo(call: PluginCall) {
        if (shouldThrottleVideoToggle()) {
            call.resolve(
                buildLocalVideoStatePayload()
                    .put("throttled", true),
            )
            return
        }
        isVideoOff = !isVideoOff
        applyLocalVideoSendState()
        sendVideoStateViaDataChannel()
        notifyListeners("onLocalVideoToggled", buildLocalVideoStatePayload())
        call.resolve(buildLocalVideoStatePayload())
    }

    @PluginMethod
    fun getLocalVideoState(call: PluginCall) {
        call.resolve(buildLocalVideoStatePayload())
    }

    fun startScreenShareNative(resultCode: Int, permissionData: Intent): Boolean {
        if (activeCallType != "video") {
            Log.w(TAG, "startScreenShareNative ignored: active call is not video")
            return false
        }
        if (resultCode != Activity.RESULT_OK) {
            Log.w(TAG, "startScreenShareNative ignored: permission result was not OK")
            return false
        }
        if (isScreenShareActive()) return true

        val factory = peerConnectionFactory
        if (factory == null) {
            Log.w(TAG, "startScreenShareNative ignored: PeerConnectionFactory unavailable")
            return false
        }
        if (localVideoSender == null || peerConnection == null) {
            Log.w(TAG, "startScreenShareNative ignored: local video sender not ready yet")
            return false
        }
        val hostActivity = CallActivity.instance ?: activity
        if (hostActivity == null) {
            Log.w(TAG, "startScreenShareNative ignored: host activity unavailable")
            return false
        }
        val eglContext = eglBase?.eglBaseContext
        if (eglContext == null) {
            Log.w(TAG, "startScreenShareNative ignored: EGL context unavailable")
            return false
        }

        val previousVideoOff = isVideoOff
        val profile = buildScreenCaptureProfile(hostActivity)

        // Fix 3 — Resource-leak prevention:
        // Create helper and source here and assign them to class fields immediately so
        // disposeScreenShareResources() can clean them up even if startCapture() throws
        // or the foreground-service start fails.  Previously these were local variables
        // outside the try block, so the catch path's disposeScreenShareResources() could
        // not reach them, leaking native objects on every failed attempt.
        val helper = SurfaceTextureHelper.create("ScreenCaptureThread", eglContext)
        val source = factory.createVideoSource(true)
        screenSurfaceTextureHelper = helper
        screenVideoSource = source

        val capturer = ScreenCapturerAndroid(
            permissionData,
            object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.w(TAG, "MediaProjection callback stopped the active screen-share session")
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        if (!isCleaningUp && isScreenShareActive()) {
                            stopScreenShareNative(
                                restoreCamera = true,
                                notifyState = true,
                                stopReason = "media_projection_stopped",
                            )
                        }
                    }
                }
            },
        )

        // Fix 4 — Hardware Encoder Limit & EGL Deadlock Prevention:
        // On many mid-range OEM devices (like Xiaomi), the hardware video encoder and EGL
        // resources cannot handle two simultaneous high-resolution capture sessions (Camera + Screen).
        // If we try to start the ScreenCapturer while the Camera is still active, the VirtualDisplay
        // silently outputs black frames or the EGL context deadlocks.
        // Solution: Safely stop the camera hardware first on a background thread. Once it's fully stopped
        // and resources are freed, we proceed to start the ScreenShareForegroundService on the main thread.
        val startScreenShareSequence = {
            ScreenShareForegroundService.start(hostActivity) {
                try {
                    capturer.initialize(helper, hostActivity, source.capturerObserver)
                    capturer.startCapture(profile.width, profile.height, profile.fps)

                    val track = factory.createVideoTrack("screen-video-track", source)
                    screenVideoCapturer = capturer
                    screenVideoTrack = track

                    wasVideoOffBeforeScreenShare = previousVideoOff
                    localVideoSourceMode = "screen"
                    isVideoOff = false
                    wasCameraCaptureSuspendedForScreenShare = false

                    val senderSwitchedToScreen = applyLocalVideoSendState()
                    if (!senderSwitchedToScreen) {
                        Log.e(TAG, "Screen share start aborted: sender refused screen track")
                        localVideoSourceMode = "camera"
                        isVideoOff = previousVideoOff
                        disposeScreenShareResources(stopService = true)
                        CallActivity.instance?.syncLocalVideoUiState()
                        return@start
                    }

                    val trackToUse = localVideoTrack
                    if (trackToUse != null) {
                        CallActivity.instance?.setLocalVideoTrack(trackToUse)
                    }
                    CallActivity.instance?.syncLocalVideoUiState()

                    applyBitrateCap()
                    sendVideoStateViaDataChannel()
                    notifyListeners("onLocalVideoToggled", buildLocalVideoStatePayload())
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to start screen share", e)
                    localVideoSourceMode = "camera"
                    isVideoOff = previousVideoOff
                    screenVideoCapturer = null
                    disposeScreenShareResources(stopService = true)
                    applyLocalVideoSendState()
                    CallActivity.instance?.syncLocalVideoUiState()
                }
            }
        }

        // CRITICAL: Do NOT stop the camera capturer before starting screen share.
        // Calling videoCapturer.stopCapture() triggers internal WebRTC cleanup that
        // disposes the RtpSender. By the time the ScreenShareForegroundService callback
        // fires on the main thread, the sender is gone and applyLocalVideoSendState() throws
        // "RtpSender has been disposed" — aborting the screen share entirely.
        // The camera encoder will remain alive but idle; WebRTC won't send its frames
        // because we swap the sender's track to the screen track in applyLocalVideoSendState().
        startScreenShareSequence()

        return true
    }

    fun stopScreenShareNative(
        restoreCamera: Boolean = true,
        notifyState: Boolean = true,
        stopReason: String = "manual_stop",
    ): Boolean {
        if (!isScreenShareActive()) return false

        Log.d(TAG, "Stopping native screen share (reason=$stopReason, restoreCamera=$restoreCamera)")
        val previousVideoOff = wasVideoOffBeforeScreenShare
        localVideoSourceMode = "camera"
        disposeScreenShareResources(stopService = true)

        isVideoOff = if (restoreCamera) previousVideoOff else true
        if (restoreCamera && !previousVideoOff) {
            val resumed = resumeLocalCameraCaptureAfterScreenShare()
            if (!resumed) {
                isVideoOff = true
            }
        } else {
            wasCameraCaptureSuspendedForScreenShare = false
        }
        val restoredSenderTrack = applyLocalVideoSendState()
        if (!restoredSenderTrack) {
            Log.w(TAG, "Failed to restore camera track after screen share; forcing video off")
            isVideoOff = true
            localVideoTrack?.setEnabled(false)
        }
        localVideoTrack?.let { CallActivity.instance?.setLocalVideoTrack(it) }
        CallActivity.instance?.refreshRendererMirroring()
        CallActivity.instance?.syncLocalVideoUiState()

        if (notifyState) {
            applyBitrateCap()
            sendVideoStateViaDataChannel()
            notifyListeners("onLocalVideoToggled", buildLocalVideoStatePayload())
        }
        return true
    }

    fun isScreenShareActiveNative(): Boolean = isScreenShareActive()

    @PluginMethod
    fun setRemoteVideoOff(call: PluginCall) {
        val videoOff = call.getBoolean("videoOff", false) ?: false
        setRemoteVideoOffNative(videoOff)
        call.resolve(JSObject().put("isRemoteVideoOff", isRemoteVideoOff))
    }

    @PluginMethod
    fun setRemoteMediaState(call: PluginCall) {
        val videoOff = call.getBoolean("videoOff", false) ?: false
        val videoSource = call.getString("videoSource", "") ?: ""
        val screenShareActive = call.getBoolean("screenShareActive", false) ?: false
        val mediaSeq = call.getLong("mediaSeq")
        setRemoteMediaStateNative(
            videoOff = videoOff,
            videoSource = videoSource,
            screenShareActive = screenShareActive,
            mediaSeq = mediaSeq,
            source = "plugin_call",
        )
        call.resolve(
            JSObject()
                .put("isRemoteVideoOff", isRemoteVideoOff)
                .put("remoteScreenShareActive", isRemoteScreenShareActive),
        )
    }

    @PluginMethod
    fun flipCamera(call: PluginCall) {
        val capturer = videoCapturer
        if (capturer == null) {
            call.reject("No camera capturer available")
            return
        }

        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                facingMode = if (isFront) "user" else "environment"
                CallActivity.instance?.refreshRendererMirroring()
                call.resolve(JSObject().put("facingMode", facingMode))
            }
            override fun onCameraSwitchError(error: String?) {
                call.reject("Failed to switch camera: $error")
            }
        })
    }

    @PluginMethod
    fun setupAudioRouting(call: PluginCall) {
        val defaultRoute = call.getString("defaultRoute", "earpiece") ?: "earpiece"
        val enableSpeaker = defaultRoute.equals("speaker", ignoreCase = true)
        val hostActivity = activity
        if (hostActivity == null) {
            call.reject("Host activity unavailable")
            return
        }

        hostActivity.runOnUiThread {
            try {
                ensureAudioRoutingInitialized(hostActivity.applicationContext)
                routeCallAudio(enableSpeaker)
                call.resolve(JSObject().put("speakerOn", isSpeakerRouteActive()))
            } catch (e: Exception) {
                call.reject("Failed to setup audio routing: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun setSpeakerRoute(call: PluginCall) {
        val enableSpeaker = call.getBoolean("enabled", false) ?: false
        val hostActivity = activity
        if (hostActivity == null) {
            call.reject("Host activity unavailable")
            return
        }

        hostActivity.runOnUiThread {
            try {
                ensureAudioRoutingInitialized(hostActivity.applicationContext)
                routeCallAudio(enableSpeaker)
                call.resolve(JSObject().put("speakerOn", isSpeakerRouteActive()))
            } catch (e: Exception) {
                call.reject("Failed to set speaker route: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun teardownAudioRouting(call: PluginCall) {
        val hostActivity = activity
        if (hostActivity == null) {
            releaseAudioRouting()
            call.resolve(JSObject().put("success", true))
            return
        }

        hostActivity.runOnUiThread {
            try {
                releaseAudioRouting()
                call.resolve(JSObject().put("success", true))
            } catch (e: Exception) {
                call.reject("Failed to restore audio routing: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun saveFile(call: PluginCall) {
        val data = call.getString("data")
        val fileName = call.getString("fileName") ?: "downloaded_file"
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        
        if (data == null) {
            call.reject("Data is required")
            return
        }
        
        val hostActivity = activity
        if (hostActivity == null) {
            call.reject("Host activity unavailable")
            return
        }

        try {
            val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
            val resolver = hostActivity.contentResolver
            
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                val contentValues = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
                    put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
                if (uri != null) {
                    resolver.openOutputStream(uri)?.use { outputStream ->
                        outputStream.write(bytes)
                    }
                    val ret = JSObject()
                    ret.put("status", "success")
                    call.resolve(ret)
                } else {
                    call.reject("Failed to create file in Downloads")
                }
            } else {
                @Suppress("DEPRECATION")
                val downloadsDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
                val file = java.io.File(downloadsDir, fileName)
                java.io.FileOutputStream(file).use { outputStream ->
                    outputStream.write(bytes)
                }
                android.media.MediaScannerConnection.scanFile(hostActivity, arrayOf(file.absolutePath), null, null)
                
                val ret = JSObject()
                ret.put("status", "success")
                call.resolve(ret)
            }
        } catch (e: Exception) {
            call.reject("Failed to save file: ${e.message}")
        }
    }

    // ==================== INTERNAL HELPERS ====================

    private fun ensureAudioRoutingInitialized(context: Context) {
        val manager = audioRoutingManager
            ?: context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

        if (!audioRoutingPrepared) {
            originalAudioRoutingMode = manager.mode
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                originalAudioRoutingCommunicationDeviceType = manager.communicationDevice?.type
            } else {
                @Suppress("DEPRECATION")
                run {
                    originalAudioRoutingSpeakerphoneOn = manager.isSpeakerphoneOn
                    originalAudioRoutingBluetoothScoOn = manager.isBluetoothScoOn
                }
            }
            requestAudioFocus(manager)
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioRoutingPrepared = true
        }

        audioRoutingManager = manager
    }

    private fun requestAudioFocus(manager: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener {}
                    .build()
            }
            audioFocusRequest?.let { manager.requestAudioFocus(it) }
            return
        }

        @Suppress("DEPRECATION")
        manager.requestAudioFocus(
            null,
            AudioManager.STREAM_VOICE_CALL,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
        )
    }

    private fun abandonAudioFocus(manager: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { manager.abandonAudioFocusRequest(it) }
            return
        }

        @Suppress("DEPRECATION")
        manager.abandonAudioFocus(null)
    }

    private fun routeCallAudio(enableSpeaker: Boolean) {
        val manager = audioRoutingManager ?: return
        // Respect explicit speaker toggle: when user requests speaker, force built-in speaker
        // instead of auto-preferring Bluetooth devices.
        if (!enableSpeaker && routeCallAudioToBluetoothIfAvailable(manager)) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val preferredType = if (enableSpeaker) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            } else {
                AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            }

            val preferredDevice = manager.availableCommunicationDevices
                .firstOrNull { it.type == preferredType }
            if (preferredDevice != null) {
                manager.setCommunicationDevice(preferredDevice)
                if (enableSpeaker) {
                    @Suppress("DEPRECATION")
                    run {
                        manager.stopBluetoothSco()
                        manager.isBluetoothScoOn = false
                        manager.isSpeakerphoneOn = true
                    }
                }
                return
            }

            if (!enableSpeaker) {
                manager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                run {
                    manager.stopBluetoothSco()
                    manager.isBluetoothScoOn = false
                    manager.isSpeakerphoneOn = true
                }
            }
            return
        }

        @Suppress("DEPRECATION")
        run {
            manager.stopBluetoothSco()
            manager.isBluetoothScoOn = false
            manager.isSpeakerphoneOn = enableSpeaker
        }
    }

    private fun isSpeakerRouteActive(): Boolean {
        val manager = audioRoutingManager ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return manager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        }
        @Suppress("DEPRECATION")
        return manager.isSpeakerphoneOn
    }

    private fun routeCallAudioToBluetoothIfAvailable(manager: AudioManager): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val bluetoothDevice = manager.availableCommunicationDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                    it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                    it.type == AudioDeviceInfo.TYPE_HEARING_AID
            }
            if (bluetoothDevice != null) {
                return manager.setCommunicationDevice(bluetoothDevice)
            }
            return false
        }

        if (!hasBluetoothOutputLegacy(manager)) return false

        @Suppress("DEPRECATION")
        run {
            manager.startBluetoothSco()
            manager.isBluetoothScoOn = true
            manager.isSpeakerphoneOn = false
        }
        return true
    }

    private fun hasBluetoothOutputLegacy(manager: AudioManager): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        return manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { device ->
            device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    (device.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                        device.type == AudioDeviceInfo.TYPE_HEARING_AID))
        }
    }

    private fun releaseAudioRouting() {
        val manager = audioRoutingManager ?: return

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val originalType = originalAudioRoutingCommunicationDeviceType
                if (originalType == null) {
                    manager.clearCommunicationDevice()
                } else {
                    val originalDevice = manager.availableCommunicationDevices
                        .firstOrNull { it.type == originalType }
                    if (originalDevice != null) {
                        manager.setCommunicationDevice(originalDevice)
                    } else {
                        manager.clearCommunicationDevice()
                    }
                }
            } else {
                @Suppress("DEPRECATION")
                run {
                    if (originalAudioRoutingBluetoothScoOn) {
                        manager.startBluetoothSco()
                        manager.isBluetoothScoOn = true
                    } else {
                        manager.stopBluetoothSco()
                        manager.isBluetoothScoOn = false
                    }
                    manager.isSpeakerphoneOn = originalAudioRoutingSpeakerphoneOn
                }
            }

            manager.mode = originalAudioRoutingMode
            abandonAudioFocus(manager)
        } finally {
            audioRoutingPrepared = false
            audioRoutingManager = null
            originalAudioRoutingCommunicationDeviceType = null
        }
    }

    private fun initializeWebRTC() {
        if (peerConnectionFactory != null && eglBase != null) return

        val hostActivity = activity
            ?: throw IllegalStateException("Host activity unavailable for WebRTC initialization")
        eglBase = eglBase ?: EglBase.create()
        val eglContext = eglBase?.eglBaseContext
            ?: throw IllegalStateException("EGL context unavailable")

        val options = PeerConnectionFactory.InitializationOptions.builder(hostActivity.applicationContext)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(options)

        // IMPORTANT: isH264HighProfileEnabled = false â€” H264 High Profile causes encoder/
        // decoder profile mismatches between different Android devices in Appâ†’App calls.
        // Chrome (Web) always uses H264 Constrained Baseline or VP8, which is why Webâ†’App
        // works fine. For native Appâ†’App, disabling High Profile forces both sides to
        // negotiate VP8 or H264 Baseline, which every Android device supports.
        val encoderFactory = DefaultVideoEncoderFactory(
            eglContext,
            /* enableIntelVp8Encoder = */ true,
            /* enableH264HighProfile = */ false  // <-- was true, caused black screen in Appâ†’App
        )
        // Use a fallback-aware decoder: hardware (with EGL context for texture frames)
        // combined with built-in software fallback via the factory.
        val decoderFactory = DefaultVideoDecoderFactory(eglContext)

        peerConnectionFactory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .setOptions(PeerConnectionFactory.Options())
            .createPeerConnectionFactory()

        Log.d(TAG, "WebRTC initialized with hardware encoder/decoder")
    }

    private fun startLocalMedia(withVideo: Boolean): Boolean {
        val factory = peerConnectionFactory ?: return false
        val hostActivity = activity ?: run {
            notifyLocalVideoFailure("activity_unavailable")
            return false
        }
        val eglContext = eglBase?.eglBaseContext ?: run {
            notifyLocalVideoFailure("egl_unavailable")
            return false
        }

        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("echoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("noiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("autoGainControl", "true"))
        }
        // Root Cause 1 fix: assign to class field, not local var, so cleanup() can dispose it.
        localAudioSource = factory.createAudioSource(audioConstraints)
        localAudioTrack = factory.createAudioTrack("audio-track", localAudioSource!!)
        localAudioTrack?.setEnabled(true)

        if (!withVideo) return true

        // Root Cause 2 fix: wait for the previous call's camera release thread to finish
        // before trying to open the camera. Camera2 is exclusive — openCamera() throws
        // CAMERA_IN_USE if the previous stopCapture() is still in progress.
        cameraReleaseThread?.let { thread ->
            if (thread.isAlive) {
                Log.d(TAG, "Waiting for previous camera to fully release before opening...")
                thread.join(2500L) // normal camera close is ~50-300ms; 2.5s is a safe ceiling
            }
            cameraReleaseThread = null
        }

        val candidates = createVideoCapturerCandidates(hostActivity)
        if (candidates.isEmpty()) {
            Log.e(TAG, "No camera backend produced a capturer")
            notifyLocalVideoFailure("no_capturer_available")
            return false
        }

        for ((index, candidate) in candidates.withIndex()) {
            val helper = SurfaceTextureHelper.create(
                "CaptureThread-${candidate.backend}",
                eglContext,
            )
            // Root Cause 1 fix: assign to class field so cleanup() can dispose it.
            val videoSource = factory.createVideoSource(candidate.capturer.isScreencast)

            try {
                candidate.capturer.initialize(helper, hostActivity, videoSource.capturerObserver)
            } catch (error: Exception) {
                Log.w(TAG, "Capturer init failed for ${candidate.backend}: ${error.message}")
                disposeCandidateAttempt(candidate.capturer, helper, videoSource)
                continue
            }

            val startedProfile = tryStartCaptureProfiles(candidate.capturer, candidate.backend)
            if (startedProfile != null) {
                Log.d(
                    TAG,
                    "Using ${candidate.backend} at ${startedProfile.width}x${startedProfile.height}@${startedProfile.fps}",
                )
                videoCapturer = candidate.capturer
                activeCaptureProfile = startedProfile
                surfaceTextureHelper = helper
                localVideoSource = videoSource  // store so cleanup() can dispose it
                localVideoSourceMode = "camera"
                localVideoTrack = factory.createVideoTrack("video-track", videoSource)
                localVideoTrack?.setEnabled(true)
                localVideoTrack?.let { CallActivity.instance?.setLocalVideoTrack(it) }
                // Release capturers we created for later fallback slots but never used.
                candidates.drop(index + 1).forEach { unused ->
                    try {
                        unused.capturer.dispose()
                    } catch (_: Exception) {
                    }
                }
                return true
            }

            disposeCandidateAttempt(candidate.capturer, helper, videoSource)
        }

        Log.e(TAG, "All capture backends failed to start local video")
        notifyLocalVideoFailure("capture_start_failed")
        return false
    }

    private fun createVideoCapturerCandidates(hostActivity: android.app.Activity): List<VideoCapturerCandidate> {
        val candidates = mutableListOf<VideoCapturerCandidate>()
        val preferFront = true

        if (Camera2Enumerator.isSupported(hostActivity)) {
            val camera2 = Camera2Enumerator(hostActivity)
            val capturer = createCapturerFromEnumerator(camera2, preferFront)
            if (capturer != null) {
                candidates.add(VideoCapturerCandidate("camera2", capturer))
            } else {
                Log.w(TAG, "Camera2 capturer unavailable")
            }
        }

        val camera1Texture = Camera1Enumerator(true)
        val capturerTexture = createCapturerFromEnumerator(camera1Texture, preferFront)
        if (capturerTexture != null) {
            candidates.add(VideoCapturerCandidate("camera1_texture", capturerTexture))
        } else {
            Log.w(TAG, "Camera1(texture) capturer unavailable")
        }

        val camera1Buffer = Camera1Enumerator(false)
        val capturerBuffer = createCapturerFromEnumerator(camera1Buffer, preferFront)
        if (capturerBuffer != null) {
            candidates.add(VideoCapturerCandidate("camera1_buffer", capturerBuffer))
        }

        return candidates
    }

    private fun tryStartCaptureProfiles(
        capturer: CameraVideoCapturer,
        backend: String,
    ): CaptureProfile? {
        val profiles = stableCaptureProfiles()

        for (profile in profiles) {
            try {
                capturer.startCapture(profile.width, profile.height, profile.fps)
                return profile
            } catch (error: Exception) {
                Log.w(
                    TAG,
                    "startCapture(${profile.width}x${profile.height}@${profile.fps}) failed on $backend: ${error.message}",
                )
            }
        }

        return null
    }

    private fun disposeCandidateAttempt(
        capturer: CameraVideoCapturer,
        helper: SurfaceTextureHelper?,
        videoSource: VideoSource?,
    ) {
        try {
            capturer.stopCapture()
        } catch (_: Exception) {
        }
        try {
            capturer.dispose()
        } catch (_: Exception) {
        }
        try {
            videoSource?.dispose()
        } catch (_: Exception) {
        }
        try {
            helper?.dispose()
        } catch (_: Exception) {
        }
    }

    private fun disposeScreenShareResources(stopService: Boolean) {
        val capturerToDispose = screenVideoCapturer
        screenVideoCapturer = null
        if (capturerToDispose != null) {
            try {
                capturerToDispose.stopCapture()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.w(TAG, "Interrupted while stopping screen capture", e)
            } catch (e: Exception) {
                Log.w(TAG, "Failed while stopping screen capture", e)
            }
            try {
                capturerToDispose.dispose()
            } catch (e: Exception) {
                Log.w(TAG, "Failed disposing screen capturer", e)
            }
        }

        screenVideoTrack?.dispose()
        screenVideoTrack = null
        screenVideoSource?.dispose()
        screenVideoSource = null
        screenSurfaceTextureHelper?.dispose()
        screenSurfaceTextureHelper = null

        if (stopService) {
            try {
                ScreenShareForegroundService.stop(context)
            } catch (e: Exception) {
                Log.w(TAG, "Failed stopping screen-share foreground service", e)
            }
        }
    }

    private fun suspendLocalCameraCaptureForScreenShare(): Boolean {
        val capturer = videoCapturer ?: return false
        return try {
            capturer.stopCapture()
            wasCameraCaptureSuspendedForScreenShare = true
            true
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.w(TAG, "Interrupted while suspending camera for screen share", e)
            false
        } catch (e: Exception) {
            Log.w(TAG, "Failed to suspend camera for screen share", e)
            false
        }
    }

    private fun resumeLocalCameraCaptureAfterScreenShare(): Boolean {
        if (!wasCameraCaptureSuspendedForScreenShare) return true
        val capturer = videoCapturer ?: return false

        fun tryStart(profile: CaptureProfile): Boolean {
            return try {
                capturer.startCapture(profile.width, profile.height, profile.fps)
                activeCaptureProfile = profile
                true
            } catch (_: Exception) {
                false
            }
        }

        val preferredProfile = activeCaptureProfile ?: stableCaptureProfiles().first()
        if (tryStart(preferredProfile)) {
            wasCameraCaptureSuspendedForScreenShare = false
            return true
        }

        for (fallback in stableCaptureProfiles()) {
            if (tryStart(fallback)) {
                wasCameraCaptureSuspendedForScreenShare = false
                return true
            }
        }

        Log.w(TAG, "Failed to resume camera capture after screen share")
        return false
    }

    private fun releasePreparedLocalMedia() {
        val capturerToDispose = videoCapturer
        videoCapturer = null
        if (capturerToDispose != null) {
            try {
                capturerToDispose.stopCapture()
            } catch (_: Exception) {
            }
            try {
                capturerToDispose.dispose()
            } catch (_: Exception) {
            }
        }

        localVideoTrack?.dispose()
        localVideoTrack = null
        localAudioTrack?.dispose()
        localAudioTrack = null
        // Root Cause 1 fix: also dispose the sources on the startup-failure path.
        localVideoSource?.dispose()
        localVideoSource = null
        localAudioSource?.dispose()
        localAudioSource = null
        activeCaptureProfile = null
        localVideoSourceMode = "camera"
        disposeScreenShareResources(stopService = true)
        wasVideoOffBeforeScreenShare = false
        wasCameraCaptureSuspendedForScreenShare = false

        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null
    }

    private fun createCapturerFromEnumerator(
        enumerator: CameraEnumerator,
        preferFront: Boolean,
    ): CameraVideoCapturer? {
        val deviceNames = enumerator.deviceNames ?: emptyArray()
        val preferredOrder = if (preferFront) {
            deviceNames.sortedBy { name -> if (enumerator.isFrontFacing(name)) 0 else 1 }
        } else {
            deviceNames.sortedBy { name -> if (enumerator.isBackFacing(name)) 0 else 1 }
        }

        preferredOrder.forEach { name ->
            try {
                val capturer = enumerator.createCapturer(name, null)
                if (capturer != null) {
                    facingMode = if (enumerator.isFrontFacing(name)) "user" else "environment"
                    return capturer
                }
            } catch (error: Exception) {
                Log.w(TAG, "Failed to create capturer for camera: $name", error)
            }
        }
        return null
    }

    private fun attachRemoteVideoTrack(track: VideoTrack) {
        try {
            track.setEnabled(true)
        } catch (_: Exception) {
        }
        remoteVideoTrack = track

        // Call UI is hidden (banner/home) or not created yet: keep track cached only.
        // The Activity will pull and attach it on reopen.
        if (!callActivityActive || CallActivity.instance == null) {
            currentAttachRunnable?.let { attachHandler.removeCallbacks(it) }
            currentAttachRunnable = null
            return
        }

        // Bug C fix: cancel ALL pending retries from any previous attach call before
        // scheduling new ones. Without this, each of the 4 call sites creates an
        // independent Runnable, resulting in up to 28 concurrent pending posts that
        // each call removeSink+addSink — tearing down the EGL surface mid-frame
        // and causing a permanent black screen on certain devices.
        // handler.removeCallbacks(null) is a safe no-op, so this is always correct.
        currentAttachRunnable?.let { attachHandler.removeCallbacks(it) }

        val startAttach = object : Runnable {
            override fun run() {
                val activity = CallActivity.instance
                if (activity != null) {
                    if (activity.isFinishing || activity.isDestroyed) {
                        attachHandler.removeCallbacks(this)
                        return
                    }
                    // Stop retries only after the first remote frame is rendered.
                    if (activity.isRemoteVideoAttached()) {
                        attachHandler.removeCallbacks(this)
                        currentAttachRunnable = null
                        return
                    }
                    try {
                        activity.setRemoteVideoTrack(track)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed while attaching remote track to CallActivity", e)
                        attachHandler.removeCallbacks(this)
                        currentAttachRunnable = null
                    }
                }
            }
        }
        currentAttachRunnable = startAttach

        // Immediate attempt
        attachHandler.post(startAttach)
        // Delayed safety nets (fallback if the surface callback fails or misses)
        val retryDelaysMs = longArrayOf(300L, 1000L, 2200L, 4000L, 6500L, 9000L)
        for (delayMs in retryDelaysMs) {
            attachHandler.postDelayed(startAttach, delayMs)
        }
    }

    private fun tryAttachRemoteTrackFromPeerConnection() {
        val track = peerConnection
            ?.transceivers
            ?.mapNotNull { it.receiver.track() as? VideoTrack }
            ?.firstOrNull()
            ?: remoteVideoTrack
            ?: return
        attachRemoteVideoTrack(track)
    }

    fun refreshRemoteTrackAttachment() {
        try {
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                tryAttachRemoteTrackFromPeerConnection()
            }
        } catch (e: Exception) {
            Log.w(TAG, "refreshRemoteTrackAttachment failed", e)
        }
    }

    fun triggerIceRecoveryFromUi(reason: String = "ui_receiver_frame_stall") {
        safeRestartIce(reason, allowPolite = true)
    }

    private fun handleRemoteDescriptionInternal(desc: SessionDescription) {
        val pc = peerConnection ?: run {
            pendingRemoteDescription = desc
            return
        }

        val isOffer = desc.type == SessionDescription.Type.OFFER
        val offerCollision =
            isOffer && (makingOffer || pc.signalingState() != PeerConnection.SignalingState.STABLE)

        ignoreOffer = !isPolite && offerCollision
        if (ignoreOffer) {
            Log.d(TAG, "Ignoring colliding offer (impolite peer)")
            return
        }

        val applyRemoteDescription = {
            pc.setRemoteDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    ignoreOffer = false
                    Log.d(TAG, "Remote description set successfully")
                    processPendingCandidates()
                    tryAttachRemoteTrackFromPeerConnection()

                    if (isOffer) {
                        pc.createAnswer(object : SdpObserver {
                            override fun onCreateSuccess(answer: SessionDescription) {
                                val preferredAnswer = withPreferredVideoCodec(answer)
                                pc.setLocalDescription(object : SdpObserver {
                                    override fun onSetSuccess() {
                                        notifyListeners("onLocalAnswer", JSObject().apply {
                                            put("type", "answer")
                                            put("sdp", preferredAnswer.description)
                                        })
                                    }
                                    override fun onSetFailure(error: String?) { Log.e(TAG, "Set local answer failed: $error") }
                                    override fun onCreateSuccess(desc: SessionDescription?) {}
                                    override fun onCreateFailure(error: String?) {}
                                }, preferredAnswer)
                            }
                            override fun onCreateFailure(error: String?) { Log.e(TAG, "Create answer failed: $error") }
                            override fun onSetSuccess() {}
                            override fun onSetFailure(error: String?) {}
                        }, MediaConstraints())
                    }
                }
                override fun onSetFailure(error: String?) {
                    Log.e(TAG, "Set remote description failed: $error")
                }
                override fun onCreateSuccess(desc: SessionDescription?) {}
                override fun onCreateFailure(error: String?) {}
            }, desc)
        }

        if (isOffer &&
            offerCollision &&
            isPolite &&
            pc.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER
        ) {
            pc.setLocalDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    applyRemoteDescription()
                }
                override fun onSetFailure(error: String?) {
                    Log.w(TAG, "Rollback before remote offer failed: $error")
                    if (pc.signalingState() == PeerConnection.SignalingState.STABLE) {
                        applyRemoteDescription()
                    }
                }
                override fun onCreateSuccess(desc: SessionDescription?) {}
                override fun onCreateFailure(error: String?) {}
            }, SessionDescription(SessionDescription.Type.ROLLBACK, ""))
            return
        }

        applyRemoteDescription()
    }

    @Synchronized
    private fun createAndSendOffer() {
        if (isCleaningUp) return
        if (makingOffer) return

        val pc = peerConnection ?: return
        if (isPolite && pc.remoteDescription == null) return
        if (pc.signalingState() != PeerConnection.SignalingState.STABLE) return

        makingOffer = true

        try {
            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(offer: SessionDescription) {
                    val preferredOffer = withPreferredVideoCodec(offer)
                    pc.setLocalDescription(object : SdpObserver {
                        override fun onSetSuccess() {
                            notifyListeners("onLocalOffer", JSObject().apply {
                                put("type", "offer")
                                put("sdp", preferredOffer.description)
                            })
                            makingOffer = false
                        }
                        override fun onSetFailure(error: String?) {
                            makingOffer = false
                            Log.e(TAG, "Set local offer failed: $error")
                        }
                        override fun onCreateSuccess(desc: SessionDescription?) {}
                        override fun onCreateFailure(error: String?) {}
                    }, preferredOffer)
                }
                override fun onCreateFailure(error: String?) {
                    makingOffer = false
                    Log.e(TAG, "Create offer failed: $error")
                }
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) {}
            }, MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "true"))
            })
        } catch (e: Exception) {
            makingOffer = false
            Log.e(TAG, "createAndSendOffer crashed", e)
        }
    }

    private fun withPreferredVideoCodec(desc: SessionDescription): SessionDescription {
        if (desc.type != SessionDescription.Type.OFFER &&
            desc.type != SessionDescription.Type.ANSWER
        ) return desc

        val preferredSdp = forceVp8Codec(desc.description)
        if (preferredSdp == desc.description) return desc
        return SessionDescription(desc.type, preferredSdp)
    }

    private fun forceVp8Codec(sdp: String): String {
        val lines = sdp.split("\r\n").toMutableList()
        val mVideoIndex = lines.indexOfFirst { it.startsWith("m=video ") }
        if (mVideoIndex < 0) return sdp

        val mParts = lines[mVideoIndex].split(" ").toMutableList()
        if (mParts.size <= 3) return sdp

        val payloads = mParts.drop(3)
        val rtpmapRegex = Regex("^a=rtpmap:(\\d+)\\s+([^/\\s]+)", RegexOption.IGNORE_CASE)
        val fmtpAptRegex = Regex("^a=fmtp:(\\d+)\\s+.*apt=(\\d+)", RegexOption.IGNORE_CASE)
        val attrPtRegex = Regex("^a=(rtpmap|fmtp|rtcp-fb):(\\d+)\\b", RegexOption.IGNORE_CASE)

        val vp8Payloads = mutableSetOf<String>()
        val removePayloads = mutableSetOf<String>()

        lines.forEach { line ->
            val match = rtpmapRegex.find(line) ?: return@forEach
            val pt = match.groupValues[1]
            val codec = match.groupValues[2].uppercase()
            if (codec == "VP8") {
                vp8Payloads.add(pt)
            } else if (codec == "H264" || codec == "H265") {
                removePayloads.add(pt)
            }
        }

        if (vp8Payloads.isEmpty() || removePayloads.isEmpty()) return sdp

        lines.forEach { line ->
            val match = fmtpAptRegex.find(line) ?: return@forEach
            val pt = match.groupValues[1]
            val apt = match.groupValues[2]
            if (removePayloads.contains(apt)) {
                removePayloads.add(pt)
            }
        }

        val filteredPayloads = payloads.filterNot { removePayloads.contains(it) }
        if (filteredPayloads.isEmpty()) return sdp

        mParts.subList(3, mParts.size).clear()
        mParts.addAll(filteredPayloads)
        lines[mVideoIndex] = mParts.joinToString(" ")

        val filteredLines = lines.filterNot { line ->
            val ptMatch = attrPtRegex.find(line) ?: return@filterNot false
            val pt = ptMatch.groupValues[2]
            removePayloads.contains(pt)
        }

        val rebuilt = filteredLines.joinToString("\r\n")
        return if (rebuilt.endsWith("\r\n")) rebuilt else "$rebuilt\r\n"
    }

    private fun processPendingCandidates() {
        val pc = peerConnection ?: return
        synchronized(pendingCandidates) {
            pendingCandidates.forEach { candidate ->
                safeAddIceCandidate(pc, candidate)
            }
            pendingCandidates.clear()
        }
    }

    private fun safeAddIceCandidate(
        pc: PeerConnection,
        candidate: IceCandidate,
    ) {
        if (isCleaningUp) return
        try {
            pc.addIceCandidate(candidate)
        } catch (e: Exception) {
            Log.w(TAG, "addIceCandidate failed; candidate skipped", e)
        }
    }

    private fun safeRestartIce(reason: String, allowPolite: Boolean = false) {
        val pc = peerConnection ?: return
        if (isCleaningUp) return
        // Keep restarts single-sided to avoid glare loops (both peers creating offers).
        // Caller/impolite peer owns restart offers; callee/polite peer only responds.
        if (isPolite && !allowPolite) {
            Log.d(TAG, "restartIce skipped for polite peer ($reason)")
            return
        }
        if (makingOffer || pc.signalingState() != PeerConnection.SignalingState.STABLE) {
            Log.d(TAG, "restartIce deferred due to unstable signaling ($reason)")
            return
        }
        try {
            pc.restartIce()
            Log.d(TAG, "restartIce requested ($reason)")
        } catch (e: Exception) {
            Log.w(TAG, "restartIce failed ($reason)", e)
        }
    }

    private fun clearDisconnectFailsafeTimer() {
        disconnectFailsafeTimer?.cancel()
        disconnectFailsafeTimer = null
    }

    private fun scheduleDisconnectFailsafe(delayMs: Long, reason: String) {
        if (isCleaningUp) return
        clearDisconnectFailsafeTimer()
        disconnectFailsafeTimer = Timer().apply {
            schedule(object : TimerTask() {
                override fun run() {
                    val state = peerConnection?.iceConnectionState()
                    val stillBroken =
                        state == PeerConnection.IceConnectionState.DISCONNECTED ||
                            state == PeerConnection.IceConnectionState.FAILED
                    if (!stillBroken || isCleaningUp) return

                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        if (isCleaningUp) return@post
                        val latestState = peerConnection?.iceConnectionState()
                        val remainsBroken =
                            latestState == PeerConnection.IceConnectionState.DISCONNECTED ||
                                latestState == PeerConnection.IceConnectionState.FAILED
                        if (!remainsBroken) return@post
                        Log.w(TAG, "Ending call after prolonged ICE $latestState ($reason)")
                        cleanup("connection_failed")
                    }
                }
            }, delayMs)
        }
    }

    private fun applyLocalVideoSendState(): Boolean {
        val track = getActiveLocalVideoTrack()

        // Self-healing sender lookup:
        // During renegotiation or UI transitions (like the screen share permission dialog),
        // the WebRTC engine or our own lifecycle logic might dispose the active RtpSender.
        // We detect this by probing the stored sender and scanning the live senders list
        // on the PeerConnection if the stored one is dead.
        fun getActiveSender(): RtpSender? {
            val stored = localVideoSender
            if (stored != null) {
                try {
                    // checkRtpSenderExists() is internal but called by setTrack().
                    // We call setTrack with the current track as a safe probe.
                    stored.setTrack(stored.track(), false)
                    return stored
                } catch (e: IllegalStateException) {
                    Log.w(TAG, "Stored localVideoSender is disposed, scanning for live replacement")
                } catch (e: Exception) {
                    // ignore other probe errors
                }
            }

            // Recovery: Find the current video sender in the peer connection.
            return peerConnection?.senders?.firstOrNull { s ->
                try {
                    // A valid video sender will either have a video track or no track at all.
                    // Accessing .track() will throw IllegalStateException if the sender is disposed.
                    val t = s.track()
                    t == null || t.kind() == "video"
                } catch (e: Exception) {
                    false
                }
            }?.also { fresh ->
                Log.w(TAG, "Recovered fresh RtpSender from peer connection")
                localVideoSender = fresh
            }
        }

        if (isVideoOff) {
            val activeSender = getActiveSender()
            try {
                val detached = activeSender?.setTrack(null, false) ?: true
                if (!detached) {
                    Log.w(TAG, "Failed to detach local video sender track")
                    return false
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to detach local video sender track", e)
                return false
            }
            localVideoTrack?.setEnabled(false)
            screenVideoTrack?.setEnabled(false)
            return true
        }

        // Always keep the camera track enabled so it can be shown in the local preview window,
        // even if we are currently sending the screen track to the remote peer.
        localVideoTrack?.setEnabled(true)
        screenVideoTrack?.setEnabled(localVideoSourceMode == "screen")
        if (track == null) {
            Log.w(TAG, "No active local video track available for sender attachment")
            return false
        }

        val activeSender = getActiveSender()
        try {
            if (activeSender != null) {
                val attached = activeSender.setTrack(track, false)
                if (!attached) {
                    Log.w(TAG, "Failed to reattach local video sender track")
                    return false
                }
            } else {
                Log.w(TAG, "No active video sender found; cannot attach track")
                return false
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to reattach local video sender track", e)
            return false
        }
        return true
    }



    private fun flushIceCandidates() {
        synchronized(candidateBuffer) {
            if (candidateBuffer.isEmpty()) return

            val jsArray = JSArray()
            candidateBuffer.forEach { candidate ->
                jsArray.put(JSObject().apply {
                    put("candidate", candidate.sdp)
                    put("sdpMid", candidate.sdpMid)
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                })
            }
            candidateBuffer.clear()

            notifyListeners("onIceCandidates", JSObject().put("candidates", jsArray))
        }
    }

    private fun applyBitrateCap() {
        peerConnection?.senders?.forEach { sender ->
            if (sender.track()?.kind() != "video") return@forEach
            try {
                val params = sender.parameters
                if (params.encodings.isNotEmpty()) {
                    val bitrate = if (isScreenShareActive()) MAX_VIDEO_BITRATE else CAMERA_VIDEO_BITRATE
                    params.encodings[0].maxBitrateBps = bitrate
                    sender.parameters = params
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to apply initial video bitrate cap", e)
            }
        }
    }

    private fun startRemoteFreezeMonitor() {
        stopRemoteFreezeMonitor()
        freezeMonitorTimer = Timer().apply {
            schedule(object : TimerTask() {
                override fun run() {
                    checkRemoteVideoHealth()
                }
            }, FREEZE_MONITOR_INTERVAL_MS, FREEZE_MONITOR_INTERVAL_MS)
        }
    }

    private fun stopRemoteFreezeMonitor() {
        freezeMonitorTimer?.cancel()
        freezeMonitorTimer = null
        lastInboundFramesDecoded = -1L
        lastInboundBytesReceived = -1L
        lastInboundAudioBytesReceived = -1L
        consecutiveRemoteFreezeChecks = 0
        consecutiveRemoteVideoOffChecks = 0
        isRemoteVideoOffHeuristic = false
        CallActivity.instance?.setRemoteVideoOffHeuristicState(false)
        lastRemoteRecoveryAtMs = 0L
        remoteRecoveryEscalation = 0
        lastOutboundFramesSent = -1L
        lastOutboundBytesSent = -1L
        consecutiveLocalFreezeChecks = 0
        lastLocalRecoveryAtMs = 0L
        localRecoveryEscalation = 0
    }

    private fun checkRemoteVideoHealth() {
        if (isCleaningUp) return
        if (!callActivityActive) return
        val pc = peerConnection ?: return
        val iceState = pc.iceConnectionState()
        if (iceState != PeerConnection.IceConnectionState.CONNECTED &&
            iceState != PeerConnection.IceConnectionState.COMPLETED
        ) return
        if (remoteVideoTrack == null) return

        try {
            pc.getStats { report ->
                var framesDecoded: Long? = null
                var bytesReceived: Long? = null
                var audioBytesReceived: Long? = null
                var framesSent: Long? = null
                var bytesSent: Long? = null

                report.statsMap.values.forEach { stats ->
                    if (stats.type == "inbound-rtp") {
                        val kind = (stats.members["kind"] as? String)?.lowercase()
                        val mediaType = (stats.members["mediaType"] as? String)?.lowercase()
                        val isVideo = kind == "video" ||
                            mediaType == "video" ||
                            stats.id.contains("video", ignoreCase = true)
                        if (!isVideo) return@forEach

                        framesDecoded = parseStatLong(stats.members["framesDecoded"])
                            ?: parseStatLong(stats.members["framesReceived"])
                        bytesReceived = parseStatLong(stats.members["bytesReceived"])
                        return@forEach
                    }
                    if (stats.type == "inbound-rtp") {
                        val kind = (stats.members["kind"] as? String)?.lowercase()
                        val mediaType = (stats.members["mediaType"] as? String)?.lowercase()
                        val isAudio = kind == "audio" ||
                            mediaType == "audio" ||
                            stats.id.contains("audio", ignoreCase = true)
                        if (!isAudio) return@forEach
                        audioBytesReceived = parseStatLong(stats.members["bytesReceived"])
                        return@forEach
                    }
                    if (stats.type != "outbound-rtp") return@forEach
                    val kind = (stats.members["kind"] as? String)?.lowercase()
                    val mediaType = (stats.members["mediaType"] as? String)?.lowercase()
                    val isVideo = kind == "video" ||
                        mediaType == "video" ||
                        stats.id.contains("video", ignoreCase = true)
                    if (!isVideo) return@forEach

                    framesSent = parseStatLong(stats.members["framesSent"])
                        ?: parseStatLong(stats.members["framesEncoded"])
                    bytesSent = parseStatLong(stats.members["bytesSent"])
                }

                evaluateRemoteVideoHealth(framesDecoded, bytesReceived, audioBytesReceived)
                evaluateLocalVideoHealth(framesSent, bytesSent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Remote freeze monitor stats read failed", e)
        }
    }

    @Synchronized
    private fun evaluateRemoteVideoHealth(
        framesDecoded: Long?,
        bytesReceived: Long?,
        audioBytesReceived: Long?,
    ) {
        // Some devices omit decode counters in inbound stats. Never trigger recovery
        // unless BOTH counters are available, otherwise false positives can freeze media.
        if (framesDecoded == null || bytesReceived == null) {
            consecutiveRemoteFreezeChecks = 0
            consecutiveRemoteVideoOffChecks = 0
            if (isRemoteVideoOffHeuristic) {
                isRemoteVideoOffHeuristic = false
                CallActivity.instance?.setRemoteVideoOffHeuristicState(false)
            }
            remoteRecoveryEscalation = 0
            if (audioBytesReceived != null) {
                lastInboundAudioBytesReceived = audioBytesReceived
            }
            return
        }

        if (lastInboundFramesDecoded < 0L && lastInboundBytesReceived < 0L) {
            lastInboundFramesDecoded = framesDecoded
            lastInboundBytesReceived = bytesReceived
            if (audioBytesReceived != null) {
                lastInboundAudioBytesReceived = audioBytesReceived
            }
            return
        }

        val hasDecodedProgress =
            framesDecoded != null &&
                lastInboundFramesDecoded >= 0L &&
                framesDecoded > lastInboundFramesDecoded
        val hasInboundBytesProgress =
            bytesReceived != null &&
                lastInboundBytesReceived >= 0L &&
                bytesReceived > lastInboundBytesReceived
        val hasAudioProgress =
            audioBytesReceived != null &&
                lastInboundAudioBytesReceived >= 0L &&
                audioBytesReceived > lastInboundAudioBytesReceived

        val inferredVideoOff = if (hasDecodedProgress || hasInboundBytesProgress) {
            consecutiveRemoteVideoOffChecks = 0
            false
        } else if (hasAudioProgress) {
            consecutiveRemoteVideoOffChecks += 1
            consecutiveRemoteVideoOffChecks >= 2
        } else {
            consecutiveRemoteVideoOffChecks = 0
            false
        }

        if (inferredVideoOff != isRemoteVideoOffHeuristic) {
            isRemoteVideoOffHeuristic = inferredVideoOff
            CallActivity.instance?.setRemoteVideoOffHeuristicState(inferredVideoOff)
        }

        if (inferredVideoOff) {
            consecutiveRemoteFreezeChecks = 0
            remoteRecoveryEscalation = 0
            lastInboundFramesDecoded = framesDecoded
            lastInboundBytesReceived = bytesReceived
            if (audioBytesReceived != null) {
                lastInboundAudioBytesReceived = audioBytesReceived
            }
            return
        }

        consecutiveRemoteFreezeChecks = when {
            hasDecodedProgress -> 0
            hasInboundBytesProgress -> consecutiveRemoteFreezeChecks + 1
            else -> 0
        }

        if (consecutiveRemoteFreezeChecks >= FREEZE_DETECT_CONSECUTIVE_CHECKS) {
            val now = System.currentTimeMillis()
            if (now - lastRemoteRecoveryAtMs >= REMOTE_RECOVERY_COOLDOWN_MS) {
                lastRemoteRecoveryAtMs = now
                consecutiveRemoteFreezeChecks = 0
                remoteRecoveryEscalation = (remoteRecoveryEscalation + 1).coerceAtMost(2)
                when (remoteRecoveryEscalation) {
                    1 -> {
                        Log.w(TAG, "Remote video stall detected. Refreshing remote track attachment.")
                        refreshRemoteTrackAttachment()
                    }
                    else -> {
                        Log.w(TAG, "Remote video stall persists. Restarting ICE.")
                        safeRestartIce("remote_video_stall", allowPolite = true)
                        remoteRecoveryEscalation = 0
                    }
                }
            }
        } else if (hasDecodedProgress) {
            remoteRecoveryEscalation = 0
        }

        lastInboundFramesDecoded = framesDecoded
        lastInboundBytesReceived = bytesReceived
        if (audioBytesReceived != null) {
            lastInboundAudioBytesReceived = audioBytesReceived
        }
    }

    @Synchronized
    private fun evaluateLocalVideoHealth(
        framesSent: Long?,
        bytesSent: Long?,
    ) {
        if (isVideoOff || activeCallType != "video") {
            consecutiveLocalFreezeChecks = 0
            localRecoveryEscalation = 0
            if (framesSent != null) lastOutboundFramesSent = framesSent
            if (bytesSent != null) lastOutboundBytesSent = bytesSent
            return
        }
        // Require complete outbound counters; partial stats are too noisy for recovery.
        if (framesSent == null || bytesSent == null) {
            consecutiveLocalFreezeChecks = 0
            return
        }

        if (lastOutboundFramesSent < 0L && lastOutboundBytesSent < 0L) {
            lastOutboundFramesSent = framesSent
            lastOutboundBytesSent = bytesSent
            return
        }

        val hasFrameProgress =
            framesSent != null &&
                lastOutboundFramesSent >= 0L &&
                framesSent > lastOutboundFramesSent
        val hasByteProgress =
            bytesSent != null &&
                lastOutboundBytesSent >= 0L &&
                bytesSent > lastOutboundBytesSent

        // Differentiate two distinct stall types so recovery is correctly targeted:
        //   hasByteProgress=true, hasFrameProgress=false → encoder/decoder stall: bytes leave the
        //     device but the encoder stopped producing frames. Camera restart is the right first step.
        //   hasByteProgress=false, hasFrameProgress=false (else) → network/ICE stall: nothing at all
        //     is leaving the device. Restarting the camera here is pointless — the pipe itself is
        //     broken. Skip straight to ICE restart with its own cooldown-guarded path.
        if (!hasFrameProgress && !hasByteProgress) {
            // Network stall: act immediately once the cooldown has passed, independent of the
            // encoder-stall counter so the two recovery paths don't interfere with each other.
            consecutiveLocalFreezeChecks = 0 // reset encoder-stall counter — different root cause
            val now = System.currentTimeMillis()
            if (now - lastLocalRecoveryAtMs >= LOCAL_RECOVERY_COOLDOWN_MS) {
                lastLocalRecoveryAtMs = now
                localRecoveryEscalation = 0
                Log.w(TAG, "Local video: zero bytes sent — network/ICE stall. Restarting ICE directly.")
                safeRestartIce("local_video_network_stall", allowPolite = true)
            }
        } else {
            // Encoder/decoder stall (bytes moving but frames stalled) or healthy — use the
            // existing escalation ladder: camera restart first, then ICE restart.
            consecutiveLocalFreezeChecks = when {
                hasFrameProgress -> 0
                else -> consecutiveLocalFreezeChecks + 1 // hasByteProgress only
            }

            if (consecutiveLocalFreezeChecks >= FREEZE_DETECT_CONSECUTIVE_CHECKS) {
                val now = System.currentTimeMillis()
                if (now - lastLocalRecoveryAtMs >= LOCAL_RECOVERY_COOLDOWN_MS) {
                    lastLocalRecoveryAtMs = now
                    consecutiveLocalFreezeChecks = 0
                    localRecoveryEscalation = (localRecoveryEscalation + 1).coerceAtMost(2)
                    when (localRecoveryEscalation) {
                        1 -> {
                            Log.w(TAG, "Local video send stall detected. Restarting camera capture.")
                            restartLocalVideoCapture()
                        }
                        else -> {
                            Log.w(TAG, "Local video send stall persists. Restarting ICE.")
                            safeRestartIce("local_video_stall", allowPolite = true)
                            localRecoveryEscalation = 0
                        }
                    }
                }
            } else if (hasFrameProgress) {
                localRecoveryEscalation = 0
            }
        }

        lastOutboundFramesSent = framesSent
        lastOutboundBytesSent = bytesSent
    }

    private fun parseStatLong(value: Any?): Long? {
        return when (value) {
            is Number -> value.toLong()
            is String -> value.toLongOrNull()
            else -> null
        }
    }

    @Synchronized
    private fun restartLocalVideoCapture() {
        if (isCleaningUp) return
        if (activeCallType != "video" || isVideoOff) return
        if (localVideoSourceMode == "screen") return
        val capturer = videoCapturer ?: return

        val profile = activeCaptureProfile ?: stableCaptureProfiles().first()
        try {
            capturer.stopCapture()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.w(TAG, "Interrupted while stopping capture for local recovery", e)
            return
        } catch (e: Exception) {
            Log.w(TAG, "stopCapture failed during local recovery", e)
        }

        fun tryStart(width: Int, height: Int, fps: Int): Boolean {
            return try {
                capturer.startCapture(width, height, fps)
                activeCaptureProfile = CaptureProfile(width, height, fps)
                true
            } catch (e: Exception) {
                false
            }
        }

        if (tryStart(profile.width, profile.height, profile.fps)) return
        for (fallback in stableCaptureProfiles()) {
            if (tryStart(fallback.width, fallback.height, fallback.fps)) return
        }

        Log.w(TAG, "Local capture restart failed for all profiles; requesting ICE restart")
        safeRestartIce("local_capture_restart_failed", allowPolite = true)
    }

    fun getEglBase(): EglBase? = eglBase
    fun getLocalVideoTrack(): VideoTrack? = getActiveLocalVideoTrack()

    fun getLocalCameraTrack(): VideoTrack? = localVideoTrack

    fun getLocalScreenTrack(): VideoTrack? = screenVideoTrack

    /**
     * Track to bind to the local preview tile (the small "you" card on screen).
     *
     * Always prefers the camera track, even while a screen share is active. Otherwise the
     * screen capturer ends up rendering itself in the preview, producing an infinity-mirror
     * recursion (the preview shows the screen, which contains the preview, ...).
     *
     * Never falls back to the screen track. If the camera is unavailable, the preview should
     * show the video-off fallback avatar, not the screen capture.
     */
    fun getLocalPreviewTrack(): VideoTrack? {
        return localVideoTrack
    }
    fun getRemoteVideoTrack(): VideoTrack? = remoteVideoTrack
    fun isPeerConnected(): Boolean = peerConnection?.iceConnectionState() == PeerConnection.IceConnectionState.CONNECTED || peerConnection?.iceConnectionState() == PeerConnection.IceConnectionState.COMPLETED
    fun getCallStartTime(): Long = callStartTime

    private fun hasOngoingCall(): Boolean {
        return peerConnection != null || localAudioTrack != null || localVideoTrack != null
    }

    private data class NativeFinalizeContext(
        val callId: String,
        val peerId: String?,
        val apiBaseUrl: String,
        val endedAtMs: Long,
        val reason: String,
        val durationSeconds: Long?,
    )

    private fun toIso8601Utc(epochMs: Long): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        return formatter.format(Date(epochMs))
    }

    private fun buildNativeFinalizeContext(reason: String): NativeFinalizeContext? {
        if (nativeFinalizeAttempted) return null

        val callId = activeCallId.trim()
        val apiBaseUrl = activeApiBaseUrl.trim().trimEnd('/')
        if (callId.isEmpty() || apiBaseUrl.isEmpty()) return null

        val endedAtMs = System.currentTimeMillis()
        val durationSeconds = when {
            callStartTime > 0L -> {
                val elapsedMs = android.os.SystemClock.elapsedRealtime() - callStartTime
                maxOf(0L, elapsedMs / 1000L)
            }
            activeCallStartedAtEpochMs > 0L -> {
                maxOf(0L, (endedAtMs - activeCallStartedAtEpochMs) / 1000L)
            }
            else -> null
        }

        nativeFinalizeAttempted = true
        val peerId = activePeerId.trim().ifEmpty { null }

        return NativeFinalizeContext(
            callId = callId,
            peerId = peerId,
            apiBaseUrl = apiBaseUrl,
            endedAtMs = endedAtMs,
            reason = reason.ifBlank { "hangup" },
            durationSeconds = durationSeconds,
        )
    }

    private fun dispatchNativeFinalizeFallback(reason: String) {
        val context = buildNativeFinalizeContext(reason) ?: return
        val endpoint = "${context.apiBaseUrl}/api/calls/finalize"
        val cookieHeader = try {
            val cookieManager = CookieManager.getInstance()
            cookieManager.getCookie(endpoint) ?: cookieManager.getCookie(context.apiBaseUrl)
        } catch (_: Exception) {
            null
        }
        val payload = JSONObject().apply {
            put("callId", context.callId)
            context.peerId?.let { put("to", it) }
            put("reason", context.reason)
            put("endedAt", toIso8601Utc(context.endedAtMs))
            context.durationSeconds?.let { put("duration", it) }
        }

        Thread {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = NATIVE_FINALIZE_CONNECT_TIMEOUT_MS
                    readTimeout = NATIVE_FINALIZE_READ_TIMEOUT_MS
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Accept", "application/json")
                    setRequestProperty("X-Native-Fallback", "true")
                    if (!cookieHeader.isNullOrBlank()) {
                        setRequestProperty("Cookie", cookieHeader)
                    }
                }

                val bytes = payload.toString().toByteArray(Charsets.UTF_8)
                connection.outputStream.use { output ->
                    output.write(bytes)
                    output.flush()
                }

                val responseCode = connection.responseCode
                if (responseCode !in 200..299) {
                    Log.w(TAG, "Native finalize fallback failed: HTTP $responseCode ($endpoint)")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Native finalize fallback failed", e)
            } finally {
                connection?.disconnect()
            }
        }.start()
    }

    @Synchronized
    private fun cleanup(endReason: String = "hangup") {
        if (isCleaningUp) return
        isCleaningUp = true

        // Bug A fix: reset isPolite immediately so a new call with reversed roles
        // (caller becomes callee, or vice-versa) never inherits the stale value.
        // isPolite governs SDP offer/answer negotiation; wrong value → no connection.
        isPolite = false

        // Bug C fix: cancel any pending remote-track attachment retries so they
        // don't fire against a CallActivity that is already being destroyed.
        currentAttachRunnable?.let { attachHandler.removeCallbacks(it) }
        currentAttachRunnable = null
        dispatchNativeFinalizeFallback(endReason)

        try {
            candidateTimer?.cancel()
            candidateTimer = null
            connectionTimeout?.cancel()
            connectionTimeout = null
            clearDisconnectFailsafeTimer()
            stopRemoteFreezeMonitor()
            releaseAudioRouting()
            disposeScreenShareResources(stopService = true)
            wasVideoOffBeforeScreenShare = false

            val capturerToStop = videoCapturer
            videoCapturer = null
            if (capturerToStop != null) {
                // Root Cause 2 fix: store the release thread so startLocalMedia() on
                // the next call can join() it, preventing CAMERA_IN_USE race.
                cameraReleaseThread = Thread {
                    try {
                        capturerToStop.stopCapture()
                    } catch (e: InterruptedException) {
                        Log.w(TAG, "Interrupted while stopping video capture", e)
                        Thread.currentThread().interrupt()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed while stopping video capture", e)
                    }
                    try {
                        capturerToStop.dispose()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed disposing video capturer", e)
                    }
                }.also { it.start() }
            }

            localVideoTrack?.dispose()
            localVideoTrack = null
            localAudioTrack?.dispose()
            localAudioTrack = null
            controlDataChannel?.let { channel ->
                try {
                    channel.unregisterObserver()
                } catch (_: Exception) {
                }
                try {
                    channel.close()
                } catch (_: Exception) {
                }
                try {
                    channel.dispose()
                } catch (_: Exception) {
                }
            }
            controlDataChannel = null
            // Root Cause 1 fix: dispose the source objects that the tracks were built from.
            // AudioTrack.dispose() and VideoTrack.dispose() do NOT cascade to their sources.
            // Each accumulated undisposed source eats native WebRTC media engine resources;
            // after ~8-10 calls the limit is hit and createAudioSource/VideoSource fails.
            localVideoSource?.dispose()
            localVideoSource = null
            localAudioSource?.dispose()
            localAudioSource = null
            localVideoSender = null
            remoteVideoTrack = null

            peerConnection?.dispose() // Use dispose instead of close for better native cleanup
            peerConnection = null

            surfaceTextureHelper?.dispose()
            surfaceTextureHelper = null

            // DO NOT dispose peerConnectionFactory and eglBase!
            // Reusing them across calls prevents native EGL segfaults when CallActivity is asynchronously tearing down.

            candidateBuffer.clear()
            pendingCandidates.clear()
            pendingRemoteDescription = null

            isMuted = false
            isVideoOff = false
            isRemoteVideoOff = false
            isRemoteScreenShareActive = false
            localVideoSourceMode = "camera"
            makingOffer = false
            ignoreOffer = false
            callStartTime = 0L
            localStreamId = java.util.UUID.randomUUID().toString()
            activeCallType = "video"
            activeIsCaller = false
            activeOtherUserName = "Unknown"
            activeOtherUserImage = ""
            activeCallId = ""
            activePeerId = ""
            activeApiBaseUrl = ""
            activeCallStartedAtEpochMs = 0L
            nativeFinalizeAttempted = false
            isInPipMode = false
            activeCaptureProfile = null
            localControlChannelSeq = 0L
            latestRemoteControlSeq = -1L
            latestRemoteMediaStateSeq = -1L
            latestRemoteSocketMediaStateSeq = -1L
            pendingControlMessage = null
            lastUiResumeRecoveryAtMs = 0L
            uiResumeRecoverySeq = 0L
            hasEverConnected = false
            lastVideoToggleAtMs = 0L

            // Close native Activity on UI thread.
            if (callActivityActive) {
                CallActivity.instance?.let { callScreen ->
                    callScreen.runOnUiThread {
                        if (!callScreen.isFinishing) {
                            callScreen.finish()
                        }
                    }
                }
                callActivityActive = false
            }

            notifyListeners("onCallEnded", JSObject())
        } finally {
            isCleaningUp = false
        }
    }
}
