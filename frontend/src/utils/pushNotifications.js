import axios from "axios";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { initializeApp } from "firebase/app";
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
} from "firebase/messaging";
import { REGISTER_PUSH_TOKEN_ROUTE } from "./constants";
import useAppStore from "../store";

const getFirebaseConfig = () => ({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

const registerPushToken = async (token, platform) => {
  if (!token) return;
  await axios.post(
    REGISTER_PUSH_TOKEN_ROUTE,
    { token, platform },
    { withCredentials: true },
  );
};

const buildPendingPayload = (rawData = {}, action) => {
  const data = rawData || {};
  const type =
    data.type ||
    (data.callId ? "call" : data.chatId || data.senderId ? "message" : "");

  const chatId =
    data.chatId || data.senderId || data.channelId || data.contactId || "";
  const chatType = data.chatType || (data.channelId ? "channel" : "contact");

  const callAction =
    action === "accept" || action === "reject" ? action : undefined;

  return {
    type,
    chatType,
    chatId,
    callId: data.callId || "",
    callerId: data.callerId || data.senderId || "",
    callType: data.callType || "audio",
    callerName: data.callerName || data.senderName || "",
    callerImage: data.callerImage || data.senderImage || "",
    callerEmail: data.callerEmail || "",
    callAction,
  };
};

const setPendingNotification = (payload) => {
  if (!payload || !payload.type) return;
  const store = useAppStore.getState();
  if (store?.setPendingNotification) {
    store.setPendingNotification(payload);
  }
};

const buildWebNotificationOptions = (data = {}) => {
  const icon =
    data.senderImage ||
    data.callerImage ||
    data.imageUrl ||
    "/web-app-manifest-192x192.png";
  const options = {
    body: data.body || "",
    icon,
    badge: "/favicon-96x96.png",
    data,
    tag: data.chatId ? `chat-${data.chatId}` : undefined,
    renotify: true,
  };

  if (data.type === "call") {
    options.tag = data.callId ? `call-${data.callId}` : "incoming-call";
    options.requireInteraction = true;
    options.vibrate = [200, 100, 200, 100, 200];
    options.actions = [
      { action: "accept", title: "Accept" },
      { action: "reject", title: "Reject" },
    ];
  }

  return options;
};

const setupWebPush = async () => {
  const supported = await isSupported();
  if (!supported || !("Notification" in window)) return () => {};

  const firebaseConfig = getFirebaseConfig();
  console.log(firebaseConfig);
  if (
    !firebaseConfig?.apiKey ||
    !firebaseConfig?.authDomain ||
    !firebaseConfig?.projectId ||
    !firebaseConfig?.messagingSenderId ||
    !firebaseConfig?.appId
  ) {
    return () => {};
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return () => {};

  const firebaseApp = initializeApp(firebaseConfig);
  const messaging = getMessaging(firebaseApp);
  const swUrl = new URL("/firebase-messaging-sw.js", window.location.origin);
  swUrl.searchParams.set("apiKey", firebaseConfig.apiKey);
  swUrl.searchParams.set("authDomain", firebaseConfig.authDomain);
  swUrl.searchParams.set("projectId", firebaseConfig.projectId);
  swUrl.searchParams.set("storageBucket", firebaseConfig.storageBucket);
  swUrl.searchParams.set("messagingSenderId", firebaseConfig.messagingSenderId);
  swUrl.searchParams.set("appId", firebaseConfig.appId);
  const serviceWorkerRegistration = await navigator.serviceWorker.register(
    swUrl.toString(),
  );

  const token = await getToken(messaging, {
    vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
    serviceWorkerRegistration,
  });

  await registerPushToken(token, "web");

  const unsubscribe = onMessage(messaging, (payload) => {
    if (Notification.permission !== "granted") return;
    const data = {
      ...(payload?.data || {}),
      title: payload?.data?.title || payload?.notification?.title || "",
      body: payload?.data?.body || payload?.notification?.body || "",
    };
    const title = data.title || "New notification";
    const options = buildWebNotificationOptions(data);
    serviceWorkerRegistration?.showNotification(title, options);
  });

  const handleServiceWorkerMessage = (event) => {
    const payload = event?.data?.payload;
    const action = event?.data?.action || event?.data?.payload?.action || "";
    if (!payload) return;
    setPendingNotification(buildPendingPayload(payload, action));
  };

  navigator.serviceWorker?.addEventListener(
    "message",
    handleServiceWorkerMessage,
  );

  return () => {
    unsubscribe();
    navigator.serviceWorker?.removeEventListener(
      "message",
      handleServiceWorkerMessage,
    );
  };
};

const setupNativePush = async () => {
  let registrationListener;
  let errorListener;
  let actionListener;
  let receiveListener;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return () => {};

  await PushNotifications.register();

  registrationListener = await PushNotifications.addListener(
    "registration",
    async (token) => {
      await registerPushToken(token.value, "android");
    },
  );

  errorListener = await PushNotifications.addListener(
    "registrationError",
    (error) => {
      console.error("Push registration error:", error);
    },
  );

  receiveListener = await PushNotifications.addListener(
    "pushNotificationReceived",
    (notification) => {
      const data = notification?.data || {};
      if (data.type !== "call") return;
      setPendingNotification(buildPendingPayload(data));
    },
  );

  actionListener = await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    (notification) => {
      const data =
        notification?.notification?.data || notification?.data || {};
      const action = notification?.actionId || "";
      setPendingNotification(buildPendingPayload(data, action));
    },
  );

  return () => {
    registrationListener?.remove();
    errorListener?.remove();
    actionListener?.remove();
    receiveListener?.remove();
  };
};

export const initializePushNotifications = async () => {
  if (Capacitor.isNativePlatform()) {
    return setupNativePush();
  }

  if ("serviceWorker" in navigator) {
    return setupWebPush();
  }

  return () => {};
};
