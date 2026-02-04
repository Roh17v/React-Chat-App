/* eslint-disable no-undef */
importScripts("https://www.gstatic.com/firebasejs/10.12.4/firebase-app-compat.js");
importScripts(
  "https://www.gstatic.com/firebasejs/10.12.4/firebase-messaging-compat.js",
);

const urlParams = new URL(self.location).searchParams;
firebase.initializeApp({
  apiKey: urlParams.get("apiKey"),
  authDomain: urlParams.get("authDomain"),
  projectId: urlParams.get("projectId"),
  storageBucket: urlParams.get("storageBucket"),
  messagingSenderId: urlParams.get("messagingSenderId"),
  appId: urlParams.get("appId"),
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || "New notification";
  const options = {
    body: payload?.notification?.body || "",
  };

  self.registration.showNotification(title, options);
});