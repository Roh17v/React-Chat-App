package com.rohit.syncronus

import android.Manifest
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
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
        private const val MAX_VIDEO_BITRATE = 350_000 // 350 kbps
        private const val ICE_BATCH_DELAY_MS = 100L
        private const val FREEZE_MONITOR_INTERVAL_MS = 4000L
        private const val FREEZE_DETECT_CONSECUTIVE_CHECKS = 3
        private const val REMOTE_RECOVERY_COOLDOWN_MS = 6000L
        private const val LOCAL_RECOVERY_COOLDOWN_MS = 8000L
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
    private var localVideoSender: RtpSender? = null
    private var remoteVideoTrack: VideoTrack? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var eglBase: EglBase? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    // Root Cause 2 fix: track camera release thread so startLocalMedia() can join
    // it before opening the camera, preventing CAMERA_IN_USE race conditions.
    @Volatile private var cameraReleaseThread: Thread? = null

    // ICE candidate batching
    private val candidateBuffer = mutableListOf<IceCandidate>()
    private var candidateTimer: Timer? = null
    private var connectionTimeout: Timer? = null
    private var freezeMonitorTimer: Timer? = null
    private var lastInboundFramesDecoded: Long = -1L
    private var lastInboundBytesReceived: Long = -1L
    private var consecutiveRemoteFreezeChecks = 0
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
    @Volatile
    private var isCleaningUp = false
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

        isPolite = !isCaller
        activeCallType = callType
        activeIsCaller = isCaller
        activeOtherUserName = otherUserName
        activeOtherUserImage = otherUserImage

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
        cleanup()
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
                        if (callStartTime == 0L) {
                            callStartTime = android.os.SystemClock.elapsedRealtime()
                        }
                        applyBitrateCap()
                        startRemoteFreezeMonitor()
                        tryAttachRemoteTrackFromPeerConnection()
                        "connected"
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> {
                        stopRemoteFreezeMonitor()
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
                        Log.d(TAG, "ICE Connection FAILED. Restarting ICE.")
                        safeRestartIce("ice_failed")
                        "failed"
                    }
                    PeerConnection.IceConnectionState.CLOSED -> {
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
            override fun onDataChannel(channel: DataChannel) {}
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

        // Add local tracks with a unique dynamically generated stream ID (prevents App-to-App collision dropping)
        localAudioTrack?.let { peerConnection?.addTrack(it, listOf(localStreamId)) }
        localVideoSender = localVideoTrack?.let { peerConnection?.addTrack(it, listOf(localStreamId)) }
        applyLocalVideoSendState()

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

    fun toggleVideoNative() {
        isVideoOff = !isVideoOff
        applyLocalVideoSendState()
    }

    fun flipCameraNative() {
        val capturer = videoCapturer ?: return
        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                facingMode = if (isFront) "user" else "environment"
            }
            override fun onCameraSwitchError(error: String?) {}
        })
    }


    fun endCallNative() {
        cleanup()
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
        isVideoOff = !isVideoOff
        applyLocalVideoSendState()
        call.resolve(JSObject().put("isVideoOff", isVideoOff))
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
                call.resolve(JSObject().put("facingMode", facingMode))
            }
            override fun onCameraSwitchError(error: String?) {
                call.reject("Failed to switch camera: $error")
            }
        })
    }

    // ==================== INTERNAL HELPERS ====================

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

    private fun applyLocalVideoSendState() {
        val sender = localVideoSender
        val track = localVideoTrack

        if (isVideoOff) {
            // Detach track from the sender: remote side receives black/silence immediately.
            // setEnabled(false) alone only pauses encoding but can leave a frozen frame.
            try { sender?.setTrack(null, false) } catch (e: Exception) {
                Log.w(TAG, "Failed to detach local video sender track", e)
            }
            track?.setEnabled(false)
            return
        }

        track?.setEnabled(true)
        try {
            if (sender != null && track != null) {
                sender.setTrack(track, false)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to reattach local video sender track", e)
        }
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
                    params.encodings[0].maxBitrateBps = MAX_VIDEO_BITRATE
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
        consecutiveRemoteFreezeChecks = 0
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
        if (!callActivityActive || isInPipMode) return
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

                evaluateRemoteVideoHealth(framesDecoded, bytesReceived)
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
    ) {
        // Some devices omit decode counters in inbound stats. Never trigger recovery
        // unless BOTH counters are available, otherwise false positives can freeze media.
        if (framesDecoded == null || bytesReceived == null) {
            consecutiveRemoteFreezeChecks = 0
            remoteRecoveryEscalation = 0
            return
        }

        if (lastInboundFramesDecoded < 0L && lastInboundBytesReceived < 0L) {
            lastInboundFramesDecoded = framesDecoded
            lastInboundBytesReceived = bytesReceived
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

        consecutiveLocalFreezeChecks = when {
            hasFrameProgress -> 0
            hasByteProgress -> consecutiveLocalFreezeChecks + 1
            else -> consecutiveLocalFreezeChecks + 1
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
    fun getLocalVideoTrack(): VideoTrack? = localVideoTrack
    fun getRemoteVideoTrack(): VideoTrack? = remoteVideoTrack
    fun isPeerConnected(): Boolean = peerConnection?.iceConnectionState() == PeerConnection.IceConnectionState.CONNECTED || peerConnection?.iceConnectionState() == PeerConnection.IceConnectionState.COMPLETED
    fun getCallStartTime(): Long = callStartTime

    private fun hasOngoingCall(): Boolean {
        return peerConnection != null || localAudioTrack != null || localVideoTrack != null
    }

    @Synchronized
    private fun cleanup() {
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

        try {
            candidateTimer?.cancel()
            candidateTimer = null
            connectionTimeout?.cancel()
            connectionTimeout = null
            stopRemoteFreezeMonitor()

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
            makingOffer = false
            ignoreOffer = false
            callStartTime = 0L
            localStreamId = java.util.UUID.randomUUID().toString()
            activeCallType = "video"
            activeIsCaller = false
            activeOtherUserName = "Unknown"
            isInPipMode = false
            activeCaptureProfile = null

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
