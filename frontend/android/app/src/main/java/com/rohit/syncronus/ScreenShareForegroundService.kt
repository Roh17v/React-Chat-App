package com.rohit.syncronus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class ScreenShareForegroundService : Service() {

    companion object {
        private const val TAG = "ScreenShareService"
        private const val CHANNEL_ID = "screen_share_channel"
        private const val CHANNEL_NAME = "Screen sharing"
        private const val NOTIFICATION_ID = 4102
        private const val ACTION_START = "com.rohit.syncronus.action.START_SCREEN_SHARE"
        private const val ACTION_STOP = "com.rohit.syncronus.action.STOP_SCREEN_SHARE"

        /**
         * Fix 1 — Android 14+ foreground-service race:
         *
         * On API 34+, MediaProjection.createVirtualDisplay() (called inside
         * ScreenCapturerAndroid.startCapture()) requires the mediaProjection foreground
         * service to have already called startForeground() before createVirtualDisplay()
         * is invoked.  ContextCompat.startForegroundService() only dispatches an Intent
         * through the system — by the time the next line on the calling thread executes,
         * onStartCommand() / startForeground() has NOT run yet.
         *
         * Solution: callers pass an [onForegroundReady] lambda.  We invoke it on the
         * main thread from onStartCommand(), AFTER startForeground() returns, so
         * startCapture() is guaranteed to run while the service is in foreground.
         */
        @Volatile
        var onForegroundReady: (() -> Unit)? = null

        fun start(context: Context, onReady: (() -> Unit)? = null) {
            onForegroundReady = onReady
            val intent = Intent(context, ScreenShareForegroundService::class.java).apply {
                action = ACTION_START
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            // Drop any pending ready callback so it cannot fire after a stop.
            onForegroundReady = null
            val intent = Intent(context, ScreenShareForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.stopService(intent)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                onForegroundReady = null
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                ensureNotificationChannel()
                val notification = buildNotification()
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        startForeground(
                            NOTIFICATION_ID,
                            notification,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                        )
                    } else {
                        startForeground(NOTIFICATION_ID, notification)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to enter mediaProjection foreground mode", e)
                    onForegroundReady = null
                    stopSelf()
                    return START_NOT_STICKY
                }

                // startForeground() has completed — it is now safe to call
                // MediaProjection.createVirtualDisplay().  Invoke the callback
                // (if any) so NativeWebRTCPlugin can proceed with startCapture().
                val callback = onForegroundReady
                onForegroundReady = null
                
                // Android 14 race condition fix:
                // Even though startForeground() has returned, the ActivityManagerService
                // (AMS) might not have fully propagated the foreground state and AppOps
                // permissions across the system. If createVirtualDisplay() is called
                // too quickly, AMS throws a SecurityException which WebRTC catches,
                // resulting in a silent black screen and an eventual onStop timeout.
                // A short delay ensures the system state has settled.
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    callback?.invoke()
                }, 300L)

                return START_STICKY
            }
            else -> return START_NOT_STICKY
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows while screen sharing is active during a call"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Screen sharing")
            .setContentText("Your screen is being shared during the call")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
