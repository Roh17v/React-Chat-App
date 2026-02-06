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

const buildUrl = (data = {}) => {
  if (data.url) return data.url;
  if (data.type === "message" || data.type === "channel-message") {
    const chatType = data.chatType || "contact";
    const chatId = data.chatId || data.senderId || data.channelId;
    if (chatId) {
      return `/chats?type=${data.type}&chatType=${chatType}&chatId=${chatId}`;
    }
  }
  if (data.type === "call" && data.callId) {
    const params = new URLSearchParams({
      type: "call",
      callId: data.callId,
      callerId: data.callerId || "",
      callType: data.callType || "audio",
      callerName: data.callerName || "",
      callerImage: data.callerImage || "",
      callerEmail: data.callerEmail || "",
    });
    return `/chats?${params.toString()}`;
  }
  return "/chats";
};

const buildNotificationOptions = (payload) => {
  const data = payload?.data || {};
  const title = data.title || payload?.notification?.title || "New notification";
  const body = data.body || payload?.notification?.body || "";
  const type = data.type;
  const icon =
    data.senderImage ||
    data.callerImage ||
    data.imageUrl ||
    "/web-app-manifest-192x192.png";

  const options = {
    body,
    icon,
    badge: "/favicon-96x96.png",
    data: {
      ...data,
      url: buildUrl(data),
    },
    tag: data.chatId ? `chat-${data.chatId}` : undefined,
    renotify: true,
  };

  if (type === "call") {
    options.tag = data.callId ? `call-${data.callId}` : "incoming-call";
    options.requireInteraction = true;
    options.vibrate = [200, 100, 200, 100, 200];
    options.actions = [
      { action: "accept", title: "Accept" },
      { action: "reject", title: "Reject" },
    ];
  }

  return { title, options };
};

messaging.onBackgroundMessage((payload) => {
  const { title, options } = buildNotificationOptions(payload);
  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification?.data || {};
  const action = event.action || "";
  const baseUrl = data.url || buildUrl(data);
  const targetUrl = (() => {
    if (data.type !== "call" || !action) return baseUrl;
    const url = new URL(baseUrl, self.location.origin);
    url.searchParams.set("callAction", action);
    return url.pathname + url.search;
  })();
  const absoluteUrl = new URL(targetUrl, self.location.origin).toString();

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({
              type: "notification-action",
              payload: { ...data, action },
            });
            if ("navigate" in client) {
              return client.navigate(absoluteUrl).then(() => client.focus());
            }
            return client.focus();
          }
        }
        return clients.openWindow(absoluteUrl);
      }),
  );
});
