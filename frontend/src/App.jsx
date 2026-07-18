import "./App.css";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import ProtectedRoute from "./components/ProtectedRoutes.jsx";
import useAppStore from "./store";
import axios from "axios";
import { HOST } from "./utils/constants";
import { AUTH_ROUTES } from "./utils/constants";
import Loader from "./components/Loader";
import AuthSplash from "./components/AuthSplash";
import { initializePushNotifications } from "./utils/pushNotifications";
import { useSocket } from "./context/SocketContext";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import NativeCallPlugin from "@/plugins/NativeCallPlugin";

const Auth = lazy(() => import("./pages/auth/Auth"));
const Chats = lazy(() => import("./pages/chats"));
const Profile = lazy(() => import("./pages/profile/Profile"));
const VerifyEmail = lazy(() => import("./pages/auth/VerifyEmail"));
const ForgotPassword = lazy(() => import("./pages/auth/ForgotPassword"));

function App() {
  const checkAuth = useAppStore((state) => state.checkAuth);
  const [isLoading, setIsLoading] = useState(true);
  // showSplash keeps the overlay mounted until its exit animation completes
  const [showSplash, setShowSplash] = useState(true);
  // splashSafetyElapsed: a 3-second hard cap so the splash never
  // permanently traps the user even when the data layer stalls (e.g.
  // SQLite plugin slow to come up on a cold boot, or a flaky network
  // delaying the bootstrap fetch). Combined with `authReady && dataReady`
  // below, the splash dismisses on whichever condition fires first.
  const [splashSafetyElapsed, setSplashSafetyElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSplashSafetyElapsed(true), 3_000);
    return () => clearTimeout(t);
  }, []);
  const setUser = useAppStore((state) => state.setUser);
  const user = useAppStore((state) => state.user);
  const authInitialized = useAppStore((state) => state.authInitialized);
  const setAuthInitialized = useAppStore((state) => state.setAuthInitialized);
  const directMessagesContacts = useAppStore(
    (state) => state.directMessagesContacts,
  );
  const channels = useAppStore((state) => state.channels);
  const connectivity = useAppStore((state) => state.connectivity);
  const bootstrapStatus = useAppStore((state) => state.bootstrapStatus);
  const offlineMode = useAppStore((state) => state.offlineMode);
  const isInitialized = useAppStore((state) => state.isInitialized);
  const setSelectedChatType = useAppStore((state) => state.setSelectedChatType);
  const setSelectedChatData = useAppStore((state) => state.setSelectedChatData);
  const pendingNotification = useAppStore(
    (state) => state.pendingNotification,
  );
  const setPendingNotification = useAppStore(
    (state) => state.setPendingNotification,
  );
  const clearPendingNotification = useAppStore(
    (state) => state.clearPendingNotification,
  );
  const setIncomingCall = useAppStore((state) => state.setIncomingCall);
  const clearIncomingCall = useAppStore((state) => state.clearIncomingCall);
  const setActiveCall = useAppStore((state) => state.setActiveCall);
  const incomingCall = useAppStore((state) => state.incomingCall);
  const activeCall = useAppStore((state) => state.activeCall);
  const navigate = useNavigate();
  const location = useLocation();
  const { socket } = useSocket();
  const closeChat = useAppStore((state) => state.closeChat);
  const selectedChatData = useAppStore((state) => state.selectedChatData);
  const chatHistoryPushedRef = useRef(false);
  const hasHydratedChatLists =
    (Array.isArray(directMessagesContacts) && directMessagesContacts.length > 0) ||
    (Array.isArray(channels) && channels.length > 0);

  // Push/pop browser history entry when chat opens/closes
  // so that the back button (hardware or browser) can close the chat
  useEffect(() => {
    if (selectedChatData && !chatHistoryPushedRef.current) {
      chatHistoryPushedRef.current = true;
      window.history.pushState({ chatOpen: true }, "");
    } else if (!selectedChatData && chatHistoryPushedRef.current) {
      chatHistoryPushedRef.current = false;
      window.history.back();
    }
  }, [selectedChatData?._id]);

  // Listen for popstate (back button) to close the chat
  useEffect(() => {
    const handlePopState = () => {
      const state = useAppStore.getState();
      if (state.selectedChatData) {
        chatHistoryPushedRef.current = false;
        state.closeChat();
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Handle Android hardware back button
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const listener = CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      const state = useAppStore.getState();

      // Priority 1: On web fullscreen call UIs, minimize first.
      // Native call banner state is managed by native call UI events (PiP/visibility).
      if (!Capacitor.isNativePlatform() && state.activeCall && !state.isCallMinimized) {
        state.setCallMinimized(true);
        return;
      }

      // If image preview is showing, close it
      if (state.showImage) {
        state.setShowImage(false);
        return;
      }

      // Priority 2: If message action menu is showing, close it
      if (state.messageActionMenu) {
        state.setMessageActionMenu(null);
        return;
      }

      // Priority 3: If avatar preview is showing, close it
      if (state.showAvatarPreview) {
        state.setShowAvatarPreview(false);
        return;
      }

      // Priority 3: If a chat is open, close it directly
      // (the useEffect watching selectedChatData will pop the history entry)
      if (state.selectedChatData) {
        state.closeChat();
        return;
      }

      // Priority 3: If on a sub-page (profile, etc.), go back in history
      if (window.location.pathname === "/profile" && canGoBack) {
        window.history.back();
        return;
      }

      // On main pages (/chats, /auth), minimize the app instead of exiting
      CapacitorApp.minimizeApp();
    });

    return () => {
      listener.then((l) => l.remove());
    };
  }, []);

  // Initialize auth on app mount - check persisted token before rendering any routes
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        // Check if token exists in Capacitor storage (fast, synchronous-like check)
        const { value: persistedToken } = await Preferences.get({
          key: "auth_token",
        });

        // If token exists, verify it with backend; otherwise, user is not authenticated
        if (persistedToken) {
          try {
            const response = await axios.get(`${HOST}${AUTH_ROUTES}/me`, {
              withCredentials: true,
              timeout: 8000, // 8 second timeout for auth check
            });

            if (response.status === 200 && response.data) {
              setUser(response.data);
              // Cache the user object so we can boot offline next time.
              try {
                await Preferences.set({
                  key: "auth_user",
                  value: JSON.stringify(response.data),
                });
              } catch (cacheErr) {
                console.warn("Could not cache user for offline boot:", cacheErr);
              }
            } else {
              // Invalid response, clear token + cached user.
              await Preferences.remove({ key: "auth_token" }).catch(() => {});
              await Preferences.remove({ key: "auth_user" }).catch(() => {});
              setUser(null);
            }
          } catch (error) {
            // Distinguish network failure from auth rejection. A 401/403
            // means the token is genuinely invalid → log the user out.
            // A network error (no response, ECONNABORTED, ERR_NETWORK,
            // timeout) means we just couldn't reach the server — keep
            // the cached user so the app opens and shows local data.
            const status = error?.response?.status;
            const isAuthRejection = status === 401 || status === 403;
            if (isAuthRejection) {
              console.log("Token rejected by backend, clearing.");
              await Preferences.remove({ key: "auth_token" }).catch(() => {});
              await Preferences.remove({ key: "auth_user" }).catch(() => {});
              setUser(null);
            } else {
              // Network failure path — try the cached user.
              console.log(
                "Auth check could not reach server, falling back to cached user.",
                error?.message,
              );
              try {
                const { value: cached } = await Preferences.get({
                  key: "auth_user",
                });
                if (cached) {
                  const parsed = JSON.parse(cached);
                  if (parsed && typeof parsed === "object") {
                    setUser(parsed);
                  } else {
                    setUser(null);
                  }
                } else {
                  setUser(null);
                }
              } catch (cacheErr) {
                console.warn(
                  "Could not read cached user for offline boot:",
                  cacheErr,
                );
                setUser(null);
              }
            }
          }
        } else {
          // No persisted token, user is not logged in
          setUser(null);
        }
      } catch (error) {
        console.error("Error during auth initialization:", error);
        setUser(null);
      } finally {
        // Mark auth as initialized - now it's safe to render routes
        setAuthInitialized(true);
      }
    };

    initializeAuth();
  }, [setUser, setAuthInitialized]);

  const handleNotificationQuery = useCallback(
    (search) => {
      const params = new URLSearchParams(search);
      if (params.size === 0) return;

    const type = params.get("type") || "";
    const chatType = params.get("chatType") || "";
    const chatId = params.get("chatId") || "";
    const callId = params.get("callId") || "";
    const callerId = params.get("callerId") || "";
    const callType = params.get("callType") || "";
    const callerName = params.get("callerName") || "";
    const callerImage = params.get("callerImage") || "";
    const callerEmail = params.get("callerEmail") || "";
    const callAction = params.get("callAction") || "";

    const inferredType =
      type || (callId ? "call" : chatId ? "message" : "");

      if (inferredType) {
        setPendingNotification({
          type: inferredType,
          chatType,
          chatId,
          callId,
          callerId,
          callType,
          callerName,
          callerImage,
          callerEmail,
          callAction,
        });
        window.history.replaceState({}, "", window.location.pathname);
      }
    },
    [setPendingNotification],
  );

  useEffect(() => {
    handleNotificationQuery(window.location.search);
  }, [handleNotificationQuery]);

  useEffect(() => {
    handleNotificationQuery(location.search);
  }, [location.search, handleNotificationQuery]);

  useEffect(() => {
    let cleanup = () => {};
    if (user) {
      initializePushNotifications()
      .then((teardown) => {
        cleanup = teardown || (() => {});
      })
      .catch((error) => {
        console.error("Failed to initialize push notifications:", error);
      });
    }

    return () => cleanup();
  }, [user]);

  // Pre-warm the native WebRTC engine so the FIRST call doesn't pay the full
  // factory + EGL + encoder/decoder allocation cost at the same instant the
  // user taps "Answer". On mid-range Android devices, doing all of that during
  // an FCM-delivered ringtone + screen wake + activity start is the most
  // reliable way to push the process over the OOM ceiling, which is what the
  // "AuthSplash → home → contacts" cold-boot symptom indicates.
  //
  // The native plugin's initialize() is idempotent (guarded by
  // `if (peerConnectionFactory != null && eglBase != null) return`), so a
  // later call from NativeCallHandler is a no-op and never re-runs the heavy
  // path. We delay 4 seconds to avoid contending with cold-start work, and
  // only run on Android where the native plugin exists.
  useEffect(() => {
    if (!user) return;
    if (!Capacitor.isNativePlatform()) return;
    if (Capacitor.getPlatform() !== "android") return;

    let cancelled = false;
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      NativeCallPlugin.initialize().catch((error) => {
        // Pre-warm is best-effort. A failure here only reverts behavior to the
        // current state (initialize on first call). Surfacing the error helps
        // distinguish device-specific WebRTC init failures from runtime ones.
        console.warn("[NativeWebRTC prewarm] initialize failed:", error);
      });
    }, 4000);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [user]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    import("@capgo/capacitor-share-target").then(({ CapacitorShareTarget }) => {
      const listener = CapacitorShareTarget.addListener("shareReceived", (event) => {
        console.log("Shared content received:", event);
        const text = event.texts && event.texts.length > 0 ? event.texts[0] : null;
        const files = [];

        if (event.files && event.files.length > 0) {
          event.files.forEach((f) => {
            files.push({
              fileUrl: f.uri,
              fileName: f.name,
              fileMimeType: f.mimeType,
            });
          });
        }
        
        if (text || files.length > 0) {
          const setPendingShareData = useAppStore.getState().setPendingShareData;
          setPendingShareData({ text, files });
          
          // If the user is on the chat view, we don't necessarily need to navigate,
          // but if they are elsewhere, we should probably take them to chats.
          if (window.location.pathname !== "/chats") {
            navigate("/chats", { replace: true });
          }
        }
      });
      return () => listener.then((l) => l.remove());
    });
  }, []);

  useEffect(() => {
    if (!pendingNotification || !user) return;

    if (pendingNotification.type === "call") {
      if (!socket) return;
      const callId = pendingNotification.callId;
      const callerId =
        pendingNotification.callerId || pendingNotification.chatId || "";
      const callType = pendingNotification.callType || "audio";
      const contactMatch = callerId
        ? directMessagesContacts?.find((item) => item._id === callerId)
        : null;
      const resolvedCallerName =
        pendingNotification.callerName ||
        `${contactMatch?.firstName || ""} ${contactMatch?.lastName || ""}`.trim() ||
        contactMatch?.email ||
        "Unknown User";
      const resolvedCallerImage =
        pendingNotification.callerImage || contactMatch?.image || "";
      const resolvedCallerEmail =
        pendingNotification.callerEmail || contactMatch?.email || "";

      if (!callId && !callerId) {
        clearPendingNotification();
        return;
      }

      if (pendingNotification.callAction === "reject") {
        socket.emit("call:reject", { callId, callerId });
        clearIncomingCall();
        clearPendingNotification();
        return;
      }

      if (pendingNotification.callAction === "accept") {
        socket.emit("call:accept", { callId, callerId });
        setActiveCall({
          callId,
          otherUserId: callerId,
          otherUserName: resolvedCallerName,
          otherUserImage: resolvedCallerImage,
          callType,
          isCaller: false,
        });
        clearIncomingCall();
        clearPendingNotification();
        if (window.location.pathname !== "/chats") {
          navigate("/chats", { replace: true });
        }
        return;
      }

      setIncomingCall({
        callId,
        callerId,
        callType,
        callerName: resolvedCallerName,
        callerImage: resolvedCallerImage,
        callerEmail: resolvedCallerEmail,
      });
      clearPendingNotification();
      if (window.location.pathname !== "/chats") {
        navigate("/chats", { replace: true });
      }
      return;
    }

    if (!pendingNotification.chatId) {
      clearPendingNotification();
      return;
    }

    const resolvedChatType =
      pendingNotification.chatType ||
      (pendingNotification.type === "channel-message"
        ? "channel"
        : "contact");

    if (resolvedChatType === "channel") {
      const channel = channels?.find(
        (item) => item._id === pendingNotification.chatId,
      );
      if (!channel) return;
      setSelectedChatType("channel");
      setSelectedChatData(channel);
      clearPendingNotification();
      if (window.location.pathname !== "/chats") {
        navigate("/chats", { replace: true });
      }
      return;
    }

    const contact = directMessagesContacts?.find(
      (item) => item._id === pendingNotification.chatId,
    );
    if (!contact) return;
    setSelectedChatType("contact");
    setSelectedChatData(contact);
    clearPendingNotification();
    if (window.location.pathname !== "/chats") {
      navigate("/chats", { replace: true });
    }
  }, [
    pendingNotification,
    user,
    socket,
    channels,
    directMessagesContacts,
    setSelectedChatType,
    setSelectedChatData,
    setIncomingCall,
    clearIncomingCall,
    setActiveCall,
    clearPendingNotification,
    navigate,
  ]);

  useEffect(() => {
    if (!directMessagesContacts?.length) return;

    const getDisplayName = (contact) =>
      `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() ||
      contact?.email ||
      "Unknown User";

    if (
      incomingCall &&
      (!incomingCall.callerName || incomingCall.callerName === "Unknown User")
    ) {
      const match = directMessagesContacts.find(
        (item) => item._id === incomingCall.callerId,
      );
      if (match) {
        setIncomingCall({
          ...incomingCall,
          callerName: getDisplayName(match),
          callerImage: incomingCall.callerImage || match.image || "",
          callerEmail: incomingCall.callerEmail || match.email || "",
        });
      }
    }

    if (
      activeCall &&
      !activeCall.isCaller &&
      (!activeCall.otherUserName || activeCall.otherUserName === "Unknown User")
    ) {
      const match = directMessagesContacts.find(
        (item) => item._id === activeCall.otherUserId,
      );
      if (match) {
        setActiveCall({
          ...activeCall,
          otherUserName: getDisplayName(match),
          otherUserImage: activeCall.otherUserImage || match.image || "",
        });
      }
    }
  }, [
    directMessagesContacts,
    incomingCall,
    activeCall,
    setIncomingCall,
    setActiveCall,
  ]);


  return (
    <>
      {/* Routes render immediately underneath — no flash possible */}
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />

          <Route
            path="/profile"
            element={
              <ProtectedRoute requireProfileSetup={false}>
                <Profile />
              </ProtectedRoute>
            }
          />
          <Route
            path="/chats"
            element={
              <ProtectedRoute requireProfileSetup={true}>
                <Chats />
              </ProtectedRoute>
            }
          ></Route>

          <Route path="*" element={<Navigate to={user ? "/chats" : "/auth"} />} />
        </Routes>
      </Suspense>

      {/* Splash overlay sits on top at z-[9999], fades out once auth resolves */}
      {showSplash && (
        <AuthSplash
          authReady={
            // Hold the splash until auth is checked AND either the data
            // layer has finished its first sync, or contacts already
            // exist in memory (cold-boot warm cache), or we have nothing
            // to wait for (logged-out / offline mode unavailable on web),
            // or the 3s safety cap has elapsed. This prevents the brief
            // "empty home screen" flash WhatsApp avoids — the user sees
            // the splash → fully populated home, not splash → blank →
            // home.
            authInitialized &&
            (
              !user || // logged out → straight to /auth
              offlineMode === "unavailable" || // web build, no offline layer
              !Capacitor.isNativePlatform() ||
              splashSafetyElapsed ||
              (
                isInitialized &&
                (
                  hasHydratedChatLists ||
                  bootstrapStatus === "ready" ||
                  bootstrapStatus === "partial"
                )
              )
            )
          }
          onDone={() => setShowSplash(false)}
        />
      )}
    </>
  );
}

export default App;
