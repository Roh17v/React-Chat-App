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
    const title = payload.notification?.title || "New notification";
    const body = payload.notification?.body || "";
    new Notification(title, { body });
  });

  return () => {
    unsubscribe();
  };
};

const setupNativePush = async () => {
  let registrationListener;
  let errorListener;

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

  return () => {
    registrationListener?.remove();
    errorListener?.remove();
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
