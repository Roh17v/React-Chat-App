package com.rohit.syncronus

import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.util.Rational
import android.view.View
import android.view.WindowManager
import android.widget.Chronometer
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import android.view.MotionEvent
import androidx.annotation.RequiresApi
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack

class CallActivity : AppCompatActivity() {

    companion object {
        var instance: CallActivity? = null
    }

    // Views
    internal lateinit var remoteVideoView: SurfaceViewRenderer
    internal lateinit var localVideoView: SurfaceViewRenderer
    private lateinit var btnMute: ImageButton
    private lateinit var btnVideo: ImageButton
    private lateinit var btnFlipPip: ImageButton
    private lateinit var btnEnd: ImageButton
    private lateinit var txtUserName: TextView
    private lateinit var txtTopName: TextView
    private lateinit var txtStatus: TextView
    private lateinit var txtAvatarInitial: TextView
    private lateinit var imgAvatar: ImageView
    private lateinit var localCameraOffOverlay: View
    private lateinit var callTimer: Chronometer
    
    // Layout containers
    private lateinit var controlsContainer: View
    private lateinit var connectingOverlay: View
    private lateinit var topBar: View
    private lateinit var localVideoContainer: View
    private lateinit var gradientTop: View
    private lateinit var gradientBottom: View

    // Animation backgrounds
    private lateinit var pulseBg1: View
    private lateinit var pulseBg2: View

    // State
    private var isMuted = false
    private var isVideoOff = false
    private var controlsVisible = true
    private var isConnected = false
    private var isLocalLarge = false
    private var enteringPipTransition = false
    private var lastKnownPipMode = false
    private var pipExitCheckRunnable: Runnable? = null
    private var swapInProgress = false
    private var lastSwapAtMs: Long = 0L
    private var lastRemoteAttachAtMs: Long = 0L
    private var frameWatchdogRunnable: Runnable? = null
    private var lastRemoteFrameAtMs: Long = 0L
    private var lastRemoteRecoveryAtMs: Long = 0L
    private var receiverFreezeRecoveries = 0
    // Delayed runnable that shows the reconnecting overlay after a brief waiting period.
    // Cancelled immediately when ICE reconnects so brief network blips never cover the video.
    private var disconnectOverlayRunnable: Runnable? = null
    // True only after the remote track actually renders a frame.
    // This is stronger than "sink added" and prevents false-positive readiness.
    private var remoteFirstFrameRendered = false

    // Video tracks
    private var localTrack: VideoTrack? = null
    private var remoteTrack: VideoTrack? = null
    private val localProxySink = SwitchingVideoSink()
    private val remoteProxySink = SwitchingVideoSink {
        lastRemoteFrameAtMs = SystemClock.elapsedRealtime()
        receiverFreezeRecoveries = 0
    }

    // Audio management
    private lateinit var audioManager: android.media.AudioManager
    private var originalAudioMode: Int = android.media.AudioManager.MODE_NORMAL
    private var originalSpeakerphoneOn: Boolean = false
    private var originalBluetoothScoOn: Boolean = false
    private var originalCommunicationDeviceType: Int? = null
    private var preferSpeakerRoute: Boolean = true
    private var audioDeviceCallback: AudioDeviceCallback? = null

    // EGL context from plugin
    private var eglBase: EglBase? = null

    private class SwitchingVideoSink(
        private val onFrameReceived: (() -> Unit)? = null,
    ) : VideoSink {
        @Volatile
        private var target: VideoSink? = null

        fun setTarget(newTarget: VideoSink?) {
            target = newTarget
        }

        override fun onFrame(frame: VideoFrame) {
            onFrameReceived?.invoke()
            target?.onFrame(frame)
        }
    }

    private fun isCurrentCallActivityInstance(): Boolean = instance === this
    private fun areRenderersReady(): Boolean =
        ::localVideoView.isInitialized && ::remoteVideoView.isInitialized

    private fun updateVideoSinkTargets() {
        if (!areRenderersReady()) return
        if (isLocalLarge) {
            localProxySink.setTarget(remoteVideoView)
            remoteProxySink.setTarget(localVideoView)
            remoteVideoView.setMirror(true)
            localVideoView.setMirror(false)
        } else {
            localProxySink.setTarget(localVideoView)
            remoteProxySink.setTarget(remoteVideoView)
            remoteVideoView.setMirror(false)
            localVideoView.setMirror(true)
        }
    }

    private fun canSwapVideos(): Boolean {
        if (!isConnected) return false
        if (enteringPipTransition || lastKnownPipMode) return false
        if (isFinishing || isDestroyed) return false
        return true
    }

    private fun startFrameWatchdog() {
        stopFrameWatchdog()
        val task = object : Runnable {
            override fun run() {
                if (isFinishing || isDestroyed) return

                val shouldCheck =
                    isConnected &&
                        !lastKnownPipMode &&
                        !enteringPipTransition &&
                        remoteTrack != null

                if (shouldCheck) {
                    val now = SystemClock.elapsedRealtime()
                    val frameAgeMs = if (lastRemoteFrameAtMs > 0L) now - lastRemoteFrameAtMs else 0L
                    val cooldownPassed = now - lastRemoteRecoveryAtMs > 3500L
                    if (frameAgeMs > 4500L && cooldownPassed) {
                        lastRemoteRecoveryAtMs = now
                        receiverFreezeRecoveries += 1
                        remoteFirstFrameRendered = false
                        NativeWebRTCPlugin.instance?.refreshRemoteTrackAttachment()
                        if (receiverFreezeRecoveries >= 2) {
                            NativeWebRTCPlugin.instance?.triggerIceRecoveryFromUi("ui_receiver_frame_stall")
                            receiverFreezeRecoveries = 0
                        }
                    }
                }

                window.decorView.postDelayed(this, 1200L)
            }
        }
        frameWatchdogRunnable = task
        window.decorView.postDelayed(task, 1200L)
    }

    private fun stopFrameWatchdog() {
        frameWatchdogRunnable?.let { window.decorView.removeCallbacks(it) }
        frameWatchdogRunnable = null
        receiverFreezeRecoveries = 0
    }

    private fun notifyCallUiClosedIfHidden() {
        if (!isCurrentCallActivityInstance()) return

        if (lastKnownPipMode) return

        if (!hasWindowFocus()) {
            NativeWebRTCPlugin.instance?.onCallUiClosed()
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun enterPipSafely(): Boolean {
        // Hide local preview BEFORE entering PiP so the PiP snapshot
        // contains only the currently large video surface.
        val previousLocalAlpha = if (::localVideoContainer.isInitialized) localVideoContainer.alpha else 1f
        if (::localVideoContainer.isInitialized) {
            localVideoContainer.alpha = 0f
        }
        enteringPipTransition = true
        val entered = enterPictureInPictureMode(getPictureInPictureParams())
        if (!entered) {
            enteringPipTransition = false
            if (::localVideoContainer.isInitialized) {
                localVideoContainer.alpha = previousLocalAlpha
            }
        }
        return entered
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {

        // Fullscreen immersive + keep screen on
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }

        setContentView(R.layout.call_activity)

        val insetsController = WindowInsetsControllerCompat(window, window.decorView)
        insetsController.hide(WindowInsetsCompat.Type.systemBars())
        insetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        initViews()
        instance = this
        applyTopBarInsets()
        setupListeners()
        setupBackNavigation()
        startPulseAnimation()

        // Get call info from intent
        val otherUserName = intent.getStringExtra("otherUserName") ?: "Unknown"
        val isCaller = intent.getBooleanExtra("isCaller", false)
        val callType = intent.getStringExtra("callType") ?: "video"

        txtUserName.text = otherUserName
        txtTopName.text = otherUserName
        txtAvatarInitial.text = if (otherUserName.isNotEmpty()) otherUserName.substring(0, 1).uppercase() else "U"
        txtStatus.text = if (isCaller) "Calling..." else "Connecting..."

        // Load other user's profile picture async (no third-party lib needed)
        val otherUserImage = intent.getStringExtra("otherUserImage") ?: ""
        if (otherUserImage.isNotEmpty()) {
            Thread {
                try {
                    val url = java.net.URL(otherUserImage)
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 5000
                    conn.readTimeout = 5000
                    conn.doInput = true
                    conn.connect()
                    val rawBitmap = BitmapFactory.decodeStream(conn.inputStream)
                    conn.disconnect()
                    if (rawBitmap != null) {
                        val circular = makeCircularBitmap(rawBitmap)
                        runOnUiThread {
                            imgAvatar.setImageBitmap(circular)
                            imgAvatar.visibility = View.VISIBLE
                            txtAvatarInitial.visibility = View.GONE
                        }
                    }
                } catch (e: Exception) {
                    // Ignore — initial letter fallback is already shown
                }
            }.start()
        }

        // Setup AudioManager for VoIP
        audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        originalAudioMode = audioManager.mode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            originalCommunicationDeviceType = audioManager.communicationDevice?.type
        } else {
            @Suppress("DEPRECATION")
            run {
                originalSpeakerphoneOn = audioManager.isSpeakerphoneOn
                originalBluetoothScoOn = audioManager.isBluetoothScoOn
            }
        }

        audioManager.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
        
        // Request audio focus to pause background music
        @Suppress("DEPRECATION")
        audioManager.requestAudioFocus(
            null, 
            android.media.AudioManager.STREAM_VOICE_CALL, 
            android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        )

        preferSpeakerRoute = callType != "audio"
        registerAudioDeviceCallback()

        // Hide video views for audio calls
        if (callType == "audio") {
            localVideoContainer.visibility = View.GONE
            btnVideo.visibility = View.GONE
            routeAudioToSpeaker(false)
        } else {
            routeAudioToSpeaker(true)
        }

        // Request video tracks from plugin *after* views are fully laid out and Surface/EGL is ready.
        // Adding tracks before Android has measured and created the SurfaceHolder causes silent
        // black screens because the WebRTC decoder fails to bind to the hardware texture.
        localVideoContainer.post {
            if (isFinishing || isDestroyed) return@post
            
            // Restore active call state if relaunching from PiP dismissal
            if (NativeWebRTCPlugin.instance?.isPeerConnected() == true) {
                isConnected = true
                txtStatus.visibility = View.GONE
                // Immediately hide overlay without animation so it doesn't flicker on reopen
                connectingOverlay.alpha = 1f
                connectingOverlay.visibility = View.GONE

                val startTime = NativeWebRTCPlugin.instance?.getCallStartTime() ?: android.os.SystemClock.elapsedRealtime()
                callTimer.base = if (startTime > 0L) startTime else android.os.SystemClock.elapsedRealtime()
                callTimer.start()

                callTimer.visibility = View.VISIBLE
                txtTopName.visibility = View.VISIBLE
            }

            // Attach local video track to this Activity's fresh renderer
            NativeWebRTCPlugin.instance?.getLocalVideoTrack()?.let { setLocalVideoTrack(it) }

            // Attach remote video track. Then schedule retry passes so a first-frame
            // failure (race between SurfaceHolder creation and track attachment)
            // self-heals without the user seeing a permanent black screen.
            NativeWebRTCPlugin.instance?.getRemoteVideoTrack()?.let { track ->
                setRemoteVideoTrack(track)
                // Retry attaching the remote track a few times until the first frame renders.
                // `window.decorView.postDelayed` is cancelled automatically when the Activity
                // is destroyed, so these are safe even across Activity restarts.
                val retryDelays = longArrayOf(250L, 800L, 2000L, 4000L)
                retryDelays.forEach { delay ->
                    window.decorView.postDelayed({
                        if (!remoteFirstFrameRendered && !isFinishing && !isDestroyed) {
                            setRemoteVideoTrack(track)
                        }
                    }, delay)
                }
            }
            
            // Re-apply camera off state visually
            updateLocalCameraOffState()
        }
        } catch (e: Exception) {
            Log.e("CallActivity", "onCreate initialization failure", e)
            NativeWebRTCPlugin.instance?.endCallNative()
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        pipExitCheckRunnable?.let { window.decorView.removeCallbacks(it) }
        pipExitCheckRunnable = null
        if (isCurrentCallActivityInstance()) {
            lastKnownPipMode = false
            NativeWebRTCPlugin.instance?.notifyCallUiVisibility(true)
        }
        startFrameWatchdog()
    }

    override fun onPause() {
        super.onPause()
    }

    private fun initViews() {
        remoteVideoView = findViewById(R.id.remote_video)
        localVideoView = findViewById(R.id.local_video)
        btnMute = findViewById(R.id.btn_mute)
        btnVideo = findViewById(R.id.btn_video)
        btnFlipPip = findViewById(R.id.btn_flip_pip)
        btnEnd = findViewById(R.id.btn_end)
        
        txtUserName = findViewById(R.id.txt_user_name)
        txtTopName = findViewById(R.id.txt_top_name)
        txtStatus = findViewById(R.id.txt_status)
        txtAvatarInitial = findViewById(R.id.txt_avatar_initial)
        imgAvatar = findViewById(R.id.img_avatar)
        localCameraOffOverlay = findViewById(R.id.local_camera_off_overlay)
        
        callTimer = findViewById(R.id.call_timer)

        controlsContainer = findViewById(R.id.controls_container)
        connectingOverlay = findViewById(R.id.connecting_overlay)
        topBar = findViewById(R.id.top_bar)
        localVideoContainer = findViewById(R.id.local_video_container)
        gradientTop = findViewById(R.id.gradient_top)
        gradientBottom = findViewById(R.id.gradient_bottom)

        pulseBg1 = findViewById(R.id.pulse_bg_1)
        pulseBg2 = findViewById(R.id.pulse_bg_2)

        // CRITICAL: The renderer (SurfaceViewRenderer) MUST be initialized with the SAME
        // EglBase.Context as the DefaultVideoDecoderFactory. If they differ, decoded GPU
        // textures from the hardware decoder are in a different GL context than the
        // renderer, causing permanent black screen. Never use EglBase.create() as fallback.
        val pluginEglBase = NativeWebRTCPlugin.instance?.getEglBase()
        if (pluginEglBase == null) {
            Log.e("CallActivity", "CRITICAL: Plugin EGL base is null — renderer will not work!")
        }
        eglBase = pluginEglBase ?: EglBase.create()
        val rendererEglBase = eglBase ?: run {
            Log.e("CallActivity", "Unable to initialize EGL renderer context")
            finish()
            return
        }

        remoteVideoView.init(rendererEglBase.eglBaseContext, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() {
                if (!isLocalLarge) {
                    remoteFirstFrameRendered = true
                    lastRemoteFrameAtMs = SystemClock.elapsedRealtime()
                }
                Log.d("CallActivity", "Remote video SurfaceView first frame rendered.")
            }
            override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
                // Bug D fix: only attempt re-attachment during initial setup (before the first
                // frame has been rendered). Once video is flowing, resolution changes (remote
                // device rotation, network-driven quality adaptation) are handled natively by
                // the renderer. Calling setRemoteVideoTrack() here mid-call causes unnecessary
                // removeSink+addSink on a live surface, producing black flashes on some devices.
                if (remoteFirstFrameRendered) return
                Log.d("CallActivity", "Remote video surface ready: ${videoWidth}x${videoHeight} — attempting track attach")
                NativeWebRTCPlugin.instance?.getRemoteVideoTrack()?.let {
                    setRemoteVideoTrack(it)
                }
            }
        })
        remoteVideoView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        remoteVideoView.setEnableHardwareScaler(false) // Disable asynchronous hardware scaling to fix swap flashes

        localVideoView.init(rendererEglBase.eglBaseContext, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() {
                // When swapped, remote track is rendered on localVideoView.
                if (isLocalLarge) {
                    remoteFirstFrameRendered = true
                    lastRemoteFrameAtMs = SystemClock.elapsedRealtime()
                }
            }
            override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
                // Intentionally empty: do NOT call setLocalVideoTrack() here.
                // This callback fires on every resolution/framerate change mid-call
                // (adaptive bitrate, rotation). Calling setLocalVideoTrack() tears down
                // and re-attaches the track on every change, causing repeated freezes.
                // Initial track attachment is handled by the post{} block in onCreate.
            }
        })
        localVideoView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        localVideoView.setEnableHardwareScaler(false)
        localVideoView.setZOrderMediaOverlay(true) // CRITICAL: forces PiP SurfaceView to render ON TOP of remote video
        localVideoView.setMirror(true)
        updateVideoSinkTargets()
    }

    private fun applyTopBarInsets() {
        val baseTopPadding = topBar.paddingTop
        val baseBottomPadding = topBar.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(topBar) { view, insets ->
            val statusBarTop = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
            val cutoutTop = insets.getInsets(WindowInsetsCompat.Type.displayCutout()).top
            val safeTopInset = maxOf(statusBarTop, cutoutTop)

            view.updatePadding(
                top = baseTopPadding + safeTopInset,
                bottom = baseBottomPadding,
            )
            insets
        }

        ViewCompat.requestApplyInsets(topBar)
    }

    private fun startPulseAnimation() {
        pulseBg1.alpha = 0.3f
        pulseBg1.animate()
            .scaleX(1.8f)
            .scaleY(1.8f)
            .alpha(0f)
            .setDuration(1500)
            .withEndAction {
                pulseBg1.scaleX = 1f
                pulseBg1.scaleY = 1f
                startPulseAnimation()
            }.start()

        pulseBg2.postDelayed({
            pulseBg2.alpha = 0.2f
            pulseBg2.animate()
                .scaleX(1.4f)
                .scaleY(1.4f)
                .alpha(0f)
                .setDuration(1500)
                .withEndAction {
                    pulseBg2.scaleX = 1f
                    pulseBg2.scaleY = 1f
                }.start()
        }, 500)
    }

    private fun setupListeners() {
        btnEnd.setOnClickListener {
            NativeWebRTCPlugin.instance?.endCallNative()
            finish()
        }

        btnMute.setOnClickListener {
            NativeWebRTCPlugin.instance?.toggleMuteNative()
            isMuted = !isMuted
            btnMute.setImageResource(if (isMuted) R.drawable.ic_mic_off else R.drawable.ic_mic)
            btnMute.alpha = if (isMuted) 0.5f else 1.0f
        }

        btnVideo.setOnClickListener {
            NativeWebRTCPlugin.instance?.toggleVideoNative()
            isVideoOff = !isVideoOff
            btnVideo.setImageResource(if (isVideoOff) R.drawable.ic_video_off else R.drawable.ic_video)
            btnVideo.alpha = if (isVideoOff) 0.5f else 1.0f
            // Show/hide the camera-off overlay on whichever view currently shows the local feed.
            // When isLocalLarge=true the local track is on remoteVideoView (swapped),
            // so we hide the entire remote surface and show the dark overlay on local container.
            updateLocalCameraOffState()
        }

        btnFlipPip.setOnClickListener {
            NativeWebRTCPlugin.instance?.flipCameraNative()
        }

        remoteVideoView.setOnClickListener {
            controlsVisible = !controlsVisible
            val alpha = if (controlsVisible) 1f else 0f
            controlsContainer.animate().alpha(alpha).setDuration(200).start()
            topBar.animate().alpha(alpha).setDuration(200).start()
            // NOTE: do NOT animate localVideoContainer.alpha here — it conflicts with the
            // translationX-based PiP hiding and with camera-off clearImage() state.
            localVideoContainer.animate().alpha(alpha).setDuration(200).start()
        }
        
        localVideoContainer.setOnClickListener {
            if (canSwapVideos()) {
                swapVideoTracks()
            }
        }
        
        setupPipDragging()
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!enterPipSafely()) {
                        finish()
                    }
                } else {
                    finish()
                }
            }
        })
    }

    private fun routeAudioToSpeaker(enableSpeaker: Boolean) {
        if (!::audioManager.isInitialized) return
        // Always prefer connected Bluetooth route when available.
        // Fallback route depends on call mode (speaker for video, earpiece for audio).
        if (routeAudioToBluetoothIfAvailable()) {
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = audioManager.availableCommunicationDevices
            val preferredType = if (enableSpeaker) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            } else {
                AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            }

            val preferredDevice = devices.firstOrNull { it.type == preferredType }
            if (preferredDevice != null) {
                audioManager.setCommunicationDevice(preferredDevice)
                return
            }

            if (!enableSpeaker) {
                audioManager.clearCommunicationDevice()
            }
            return
        }

        @Suppress("DEPRECATION")
        run {
            audioManager.stopBluetoothSco()
            audioManager.isBluetoothScoOn = false
            audioManager.isSpeakerphoneOn = enableSpeaker
        }
    }

    private fun registerAudioDeviceCallback() {
        if (!::audioManager.isInitialized) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (audioDeviceCallback != null) return

        audioDeviceCallback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                routeAudioToSpeaker(preferSpeakerRoute)
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                routeAudioToSpeaker(preferSpeakerRoute)
            }
        }
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, null)
    }

    private fun unregisterAudioDeviceCallback() {
        if (!::audioManager.isInitialized) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val callback = audioDeviceCallback ?: return
        audioManager.unregisterAudioDeviceCallback(callback)
        audioDeviceCallback = null
    }

    private fun routeAudioToBluetoothIfAvailable(): Boolean {
        if (!::audioManager.isInitialized) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val bluetoothDevice = audioManager.availableCommunicationDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                    it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                    it.type == AudioDeviceInfo.TYPE_HEARING_AID
            }
            if (bluetoothDevice != null) {
                return audioManager.setCommunicationDevice(bluetoothDevice)
            }
            return false
        }

        if (!hasBluetoothOutputDeviceLegacy()) return false

        @Suppress("DEPRECATION")
        run {
            audioManager.startBluetoothSco()
            audioManager.isBluetoothScoOn = true
            audioManager.isSpeakerphoneOn = false
        }
        return true
    }

    private fun hasBluetoothOutputDeviceLegacy(): Boolean {
        if (!::audioManager.isInitialized) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        return audioManager.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).any { device ->
            device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    (device.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                        device.type == AudioDeviceInfo.TYPE_HEARING_AID))
        }
    }

    private fun restoreOriginalAudioRoute() {
        if (!::audioManager.isInitialized) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val originalType = originalCommunicationDeviceType
            if (originalType == null) {
                audioManager.clearCommunicationDevice()
                return
            }

            val originalDevice = audioManager.availableCommunicationDevices
                .firstOrNull { it.type == originalType }
            if (originalDevice != null) {
                audioManager.setCommunicationDevice(originalDevice)
            } else {
                audioManager.clearCommunicationDevice()
            }
            return
        }

        @Suppress("DEPRECATION")
        run {
            if (originalBluetoothScoOn) {
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
            } else {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
            }
            audioManager.isSpeakerphoneOn = originalSpeakerphoneOn
        }
    }
    
    private fun setupPipDragging() {
        var dX = 0f
        var dY = 0f
        var downRawX = 0f
        var downRawY = 0f
        var isDragging = false
        val tapSlopPx = resources.displayMetrics.density * 18f

        localVideoContainer.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dX = view.x - event.rawX
                    dY = view.y - event.rawY
                    downRawX = event.rawX
                    downRawY = event.rawY
                    isDragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val newX = event.rawX + dX
                    val newY = event.rawY + dY

                    val totalMove = kotlin.math.hypot(event.rawX - downRawX, event.rawY - downRawY)
                    if (totalMove > tapSlopPx) {
                        isDragging = true
                    }

                    if (isDragging) {
                        val bounds = getPipDragBounds(view)

                        view.x = newX.coerceIn(bounds.minX, bounds.maxX)
                        view.y = newY.coerceIn(bounds.minY, bounds.maxY)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val totalMove = kotlin.math.hypot(event.rawX - downRawX, event.rawY - downRawY)
                    if (!isDragging || totalMove <= tapSlopPx) {
                        if (canSwapVideos()) swapVideoTracks()
                    } else {
                        snapToCorner(view)
                    }
                    true
                }
                else -> false
            }
        }
    }

    private data class PipDragBounds(
        val minX: Float,
        val maxX: Float,
        val minY: Float,
        val maxY: Float,
    )

    private fun getPipDragBounds(view: View): PipDragBounds {
        val parent = view.parent as? View
            ?: return PipDragBounds(0f, 0f, 0f, 0f)

        val density = resources.displayMetrics.density
        val sideMargin = 12f * density
        val verticalGap = 12f * density

        val maxPossibleX = (parent.width - view.width).toFloat().coerceAtLeast(0f)
        val minX = sideMargin.coerceAtMost(maxPossibleX)
        val maxX = (maxPossibleX - sideMargin).coerceAtLeast(minX)

        val rootInsets = ViewCompat.getRootWindowInsets(parent)
        val topSystemInset = rootInsets
            ?.getInsets(WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout())
            ?.top
            ?.toFloat()
            ?: 0f

        val headerBottom = topBar.bottom.toFloat()
        val minY = (maxOf(topSystemInset, headerBottom) + verticalGap).coerceAtLeast(0f)

        val maxPossibleY = (parent.height - view.height).toFloat().coerceAtLeast(0f)
        val controlsTop = if (controlsContainer.height > 0) controlsContainer.top.toFloat() else parent.height.toFloat()
        val controlsSafeTop = controlsTop - view.height - verticalGap
        val maxY = minOf(maxPossibleY, controlsSafeTop).coerceAtLeast(minY)

        return PipDragBounds(minX, maxX, minY, maxY)
    }

    private fun snapToCorner(view: View) {
        val bounds = getPipDragBounds(view)
        val midX = (bounds.minX + bounds.maxX) / 2f
        val midY = (bounds.minY + bounds.maxY) / 2f

        val targetX = if (view.x < midX) bounds.minX else bounds.maxX
        val targetY = if (view.y < midY) bounds.minY else bounds.maxY
                      
        view.animate()
            .x(targetX)
            .y(targetY)
            .setDuration(300)
            .setInterpolator(android.view.animation.DecelerateInterpolator())
            .start()
    }
    
    private fun swapVideoTracksSync() {
        if (!areRenderersReady()) return
        if (!canSwapVideos()) return
        // No tracks yet (e.g. reopen window before post{} finishes) - nothing to swap.
        if (localTrack == null && remoteTrack == null) return

        val now = SystemClock.elapsedRealtime()
        if (swapInProgress || now - lastSwapAtMs < 450L) return
        swapInProgress = true

        try {
            isLocalLarge = !isLocalLarge

            // Swap only by retargeting proxy sinks; avoid detach/attach churn on live tracks.
            updateVideoSinkTargets()
            updateLocalCameraOffState()
            lastSwapAtMs = SystemClock.elapsedRealtime()
        } catch (e: Exception) {
            Log.e("CallActivity", "swapVideoTracksSync failed", e)
            // Roll back isLocalLarge so state stays consistent with what was actually attached
            isLocalLarge = !isLocalLarge
        } finally {
            swapInProgress = false
        }
    }

    private fun swapVideoTracks() {
        runOnUiThread {
            swapVideoTracksSync()
        }
    }

    /**
     * Show/hide the camera-off overlay for the local feed.
     *
     * IMPORTANT: Never set SurfaceViewRenderer (SurfaceView) visibility to INVISIBLE or GONE!
     * Doing so destroys the underlying EGL surface, causing crashes when code later tries
     * to attach tracks or render frames. Instead, use clearImage() for black and overlays for UX.
     *
     * isLocalLarge=false: local → localVideoView (small card), remote → remoteVideoView (large)
     * isLocalLarge=true:  local → remoteVideoView (large),     remote → localVideoView (small)
     */
    private fun updateLocalCameraOffState() {
        if (isVideoOff) {
            if (isLocalLarge) {
                // Local feed is on remoteVideoView (large bg) — clear it to black
                // No overlay needed for the large view; clearImage() is sufficient
                try { remoteVideoView.clearImage() } catch (_: Exception) {}
                localCameraOffOverlay.visibility = View.GONE
            } else {
                // Local feed is on localVideoView (small card) — clear + show overlay on top
                try { localVideoView.clearImage() } catch (_: Exception) {}
                localCameraOffOverlay.visibility = View.VISIBLE
            }
        } else {
            // Camera is on — live frames will naturally replace any black; just hide the overlay
            localCameraOffOverlay.visibility = View.GONE
        }
    }
    /**
     * Crops a bitmap to a circle. Used to make profile pictures round.
     */
    private fun makeCircularBitmap(src: Bitmap): Bitmap {
        val size = minOf(src.width, src.height)
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(output)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
        val left = ((src.width - size) / 2).toFloat()
        val top = ((src.height - size) / 2).toFloat()
        canvas.drawBitmap(src, -left, -top, paint)
        return output
    }

    fun setLocalVideoTrack(track: VideoTrack) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            if (!areRenderersReady()) return@runOnUiThread
            try {
                if (track === localTrack) {
                    updateVideoSinkTargets()
                    return@runOnUiThread
                }
                localTrack?.removeSink(localProxySink)
                track.removeSink(localProxySink)
                localTrack = track
                track.addSink(localProxySink)
                updateVideoSinkTargets()
            } catch (e: Exception) {
                Log.e("CallActivity", "Failed to set local video track", e)
            }
        }
    }

    fun setRemoteVideoTrack(track: VideoTrack) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            if (!areRenderersReady()) return@runOnUiThread
            try {
                val now = SystemClock.elapsedRealtime()
                // If this exact track is already flowing (first frame rendered), skip reattach.
                if (track === remoteTrack && remoteFirstFrameRendered) return@runOnUiThread
                // Throttle repeated same-track attach attempts during PiP-dismiss/reopen races.
                if (track === remoteTrack && now - lastRemoteAttachAtMs < 500L) return@runOnUiThread

                val isNewTrack = track !== remoteTrack

                // Keep a stable sink wiring model: track -> proxy sink -> active renderer target.
                remoteTrack?.removeSink(remoteProxySink)
                track.removeSink(remoteProxySink)

                remoteTrack = track
                // Reset first-frame flag only when the track reference actually changes.
                if (isNewTrack) {
                    remoteFirstFrameRendered = false
                    lastRemoteFrameAtMs = 0L
                }

                track.addSink(remoteProxySink)
                updateVideoSinkTargets()
                lastRemoteAttachAtMs = now

                connectingOverlay.animate().alpha(0f).setDuration(300).withEndAction {
                    connectingOverlay.visibility = View.GONE
                }.start()
            } catch (e: Exception) {
                Log.e("CallActivity", "Failed to set remote video track", e)
            }
        }
    }

    /** Called by NativeWebRTCPlugin retry loop to stop only after first remote frame is rendered. */
    fun isRemoteVideoAttached(): Boolean = remoteFirstFrameRendered

    fun syncTimerBase(baseElapsedRealtime: Long) {
        if (baseElapsedRealtime <= 0L) return
        runOnUiThread {
            callTimer.base = baseElapsedRealtime
            if (isConnected) {
                callTimer.start()
                callTimer.visibility = View.VISIBLE
                txtTopName.visibility = View.VISIBLE
            }
        }
    }

    fun onConnectionStateChanged(state: String) {
        runOnUiThread {
            if (!::connectingOverlay.isInitialized ||
                !::txtStatus.isInitialized ||
                !::callTimer.isInitialized ||
                !::txtTopName.isInitialized
            ) return@runOnUiThread
            when (state) {
                "connected" -> {
                    isConnected = true
                    startFrameWatchdog()
                    txtStatus.visibility = View.GONE
                    routeAudioToSpeaker(preferSpeakerRoute)

                    // Cancel any pending disconnect overlay — connection recovered before it showed.
                    disconnectOverlayRunnable?.let { window.decorView.removeCallbacks(it) }
                    disconnectOverlayRunnable = null

                    if (callTimer.visibility != View.VISIBLE) {
                        val syncedStartTime =
                            NativeWebRTCPlugin.instance?.getCallStartTime()
                                ?.takeIf { it > 0L }
                                ?: SystemClock.elapsedRealtime()
                        callTimer.base = syncedStartTime
                        callTimer.start()
                        callTimer.visibility = View.VISIBLE
                    }
                    txtTopName.visibility = View.VISIBLE

                    connectingOverlay.animate().alpha(0f).setDuration(300).withEndAction {
                        connectingOverlay.visibility = View.GONE
                    }.start()

                    // Some devices report connected before renderer + track binding settles.
                    // Re-try remote track attachment a few times until first frame appears.
                    val reconnectDelays = longArrayOf(180L, 650L, 1500L, 2800L)
                    reconnectDelays.forEach { delayMs ->
                        window.decorView.postDelayed({
                            if (!remoteFirstFrameRendered && !isFinishing && !isDestroyed) {
                                NativeWebRTCPlugin.instance?.refreshRemoteTrackAttachment()
                            }
                        }, delayMs)
                    }
                }
                "disconnected" -> {
                    stopFrameWatchdog()
                    // Delay showing the overlay by 2.5 seconds before covering the video.
                    // Most ICE disconnects on mobile networks (tower handoff, brief signal drop)
                    // self-heal in 1-2 seconds — the native plugin has its own 2s ICE restart
                    // timer. Showing the overlay immediately made every brief blip look like a
                    // freeze. If still disconnected after 2.5s, show the overlay.
                    if (disconnectOverlayRunnable == null) {
                        val runnable = Runnable {
                            if (!isFinishing && !isDestroyed) {
                                connectingOverlay.alpha = 1f
                                connectingOverlay.visibility = View.VISIBLE
                                txtStatus.text = "Reconnecting..."
                                txtStatus.visibility = View.VISIBLE
                            }
                            disconnectOverlayRunnable = null
                        }
                        disconnectOverlayRunnable = runnable
                        window.decorView.postDelayed(runnable, 2500L)
                    }
                }
                "failed" -> {
                    stopFrameWatchdog()
                    // ICE failed is not self-healing: show overlay immediately.
                    disconnectOverlayRunnable?.let { window.decorView.removeCallbacks(it) }
                    disconnectOverlayRunnable = null
                    connectingOverlay.alpha = 1f
                    connectingOverlay.visibility = View.VISIBLE
                    txtStatus.text = "Connection Failed"
                    txtStatus.visibility = View.VISIBLE
                }
                "closed" -> {
                    stopFrameWatchdog()
                    finish()
                }
            }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        enteringPipTransition = false
        lastKnownPipMode = isInPictureInPictureMode

        NativeWebRTCPlugin.instance?.notifyPipModeChange(isInPictureInPictureMode)
        
        if (isInPictureInPictureMode) {
            // Hide controls in PiP mode
            controlsContainer.visibility = View.GONE
            topBar.visibility = View.GONE
            gradientTop.visibility = View.GONE
            gradientBottom.visibility = View.GONE
            connectingOverlay.visibility = View.GONE
            
            // Move localVideoContainer off-screen using translation instead of changing visibility.
            // CRITICAL: Setting INVISIBLE/GONE on a parent that contains a SurfaceViewRenderer
            // propagates to the SurfaceView child and destroys its EGL surface, causing crashes
            // when tracks try to attach or render after PiP exit.
            // translationX moves the card outside the PiP capture area while keeping
            // the EGL surface alive and rendering normally (just off-screen).
            localVideoContainer.translationX = 5000f
        } else {
            // Restore controls when expanding PiP back to full-screen
            controlsContainer.visibility = View.VISIBLE
            topBar.visibility = View.VISIBLE
            gradientTop.visibility = View.VISIBLE
            gradientBottom.visibility = View.VISIBLE

            if (!isConnected) {
                connectingOverlay.visibility = View.VISIBLE
            }
            
            localVideoContainer.translationX = 0f
            // Restore alpha that enterPipSafely() set to 0f for the PiP snapshot.
            // That zero-alpha is never reset on the success path, so without this line
            // the card is back in position but fully transparent — tapping it triggers
            // swapVideoTracks() on what looks like empty screen space.
            localVideoContainer.alpha = 1f
            // Always show controls and card when returning to fullscreen.
            controlsContainer.alpha = 1f
            topBar.alpha = 1f
            controlsVisible = true

            // Force a fresh layout pass. When the Activity resizes from the tiny PiP
            // window back to full-screen, ConstraintLayout can retain stale measure
            // results from the PiP dimensions, leaving the UI broken or clipped.
            // requestLayout() triggers a full re-measure so everything fills the screen.
            window.decorView.requestLayout()
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Auto-enter PiP when hitting home button if call is active
        if (isConnected && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            enterPipSafely()
        }
    }

    override fun onStop() {
        super.onStop()
        stopFrameWatchdog()
        // Skip only when we are actively transitioning INTO PiP mode.
        // The activity going to Stop in that case is expected (PiP window is showing).
        if (enteringPipTransition) return

        // If we were in PiP mode (lastKnownPipMode=true) and onStop fires, the PiP
        // window is being dismissed via the × button. Always notify the JS side so
        // the green banner can appear. (onPictureInPictureModeChanged may fire before
        // OR after onStop depending on the Android version, so we cannot rely on
        // lastKnownPipMode being reset before we get here.)
        if (isCurrentCallActivityInstance()) {
            NativeWebRTCPlugin.instance?.notifyCallUiVisibility(false)
        }
        notifyCallUiClosedIfHidden()
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            stopFrameWatchdog()
            unregisterAudioDeviceCallback()
            pipExitCheckRunnable?.let { window.decorView.removeCallbacks(it) }
            pipExitCheckRunnable = null
            disconnectOverlayRunnable?.let { window.decorView.removeCallbacks(it) }
            disconnectOverlayRunnable = null
            enteringPipTransition = false
            lastKnownPipMode = false

            if (::audioManager.isInitialized) {
                audioManager.mode = originalAudioMode
                restoreOriginalAudioRoute()
                @Suppress("DEPRECATION")
                audioManager.abandonAudioFocus(null)
            }

            if (areRenderersReady()) {
                // CRITICAL ORDER: remove track sinks BEFORE releasing renderers.
                // If a track is still bound when release() is called, the track retains
                // a pointer to the destroyed EGL surface. The next CallActivity then calls
                // addSink() on a fresh renderer but the track internally still references
                // the dead surface → crash or silent black screen (remote freeze).
                localTrack?.removeSink(localProxySink)
                remoteTrack?.removeSink(remoteProxySink)
                localProxySink.setTarget(null)
                remoteProxySink.setTarget(null)
                localVideoView.release()
                remoteVideoView.release()
            }
            remoteFirstFrameRendered = false
            swapInProgress = false
            lastSwapAtMs = 0L
            lastRemoteAttachAtMs = 0L
            lastRemoteFrameAtMs = 0L
            lastRemoteRecoveryAtMs = 0L
        } catch (e: Exception) {
            Log.e("CallActivity", "onDestroy cleanup failure", e)
        } finally {
            if (isCurrentCallActivityInstance()) {
                NativeWebRTCPlugin.instance?.onCallUiClosed()
                instance = null
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun getPictureInPictureParams(): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
        builder.setAspectRatio(Rational(9, 16))

        val sourceRectHint = android.graphics.Rect()
        remoteVideoView.getGlobalVisibleRect(sourceRectHint)
        builder.setSourceRectHint(sourceRectHint)

        return builder.build()
    }
}
