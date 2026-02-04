import admin from "firebase-admin";

let firebaseApp;

const initFirebase = () => {
  if (firebaseApp) return firebaseApp;
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) return null;

  try {
    const serviceAccount = JSON.parse(serviceAccountRaw);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return firebaseApp;
  } catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error);
    return null;
  }
};

const sanitizeDataPayload = (data = {}) =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)]),
  );

const normalizeTokens = (tokens = []) =>
  tokens
    .map((entry) =>
      typeof entry === "string" ? { token: entry } : entry || {},
    )
    .filter((entry) => entry.token);

const splitTokensByPlatform = (tokens = []) =>
  tokens.reduce(
    (acc, entry) => {
      const platform = (entry.platform || "unknown").toLowerCase();
      if (platform === "web") acc.web.push(entry.token);
      else if (platform === "android") acc.android.push(entry.token);
      else if (platform === "ios") acc.ios.push(entry.token);
      else acc.unknown.push(entry.token);
      return acc;
    },
    { web: [], android: [], ios: [], unknown: [] },
  );

export const sendPushToTokens = async ({
  tokens,
  title,
  body,
  data,
  imageUrl,
}) => {
  if (!tokens || tokens.length === 0) return;
  const app = initFirebase();
  if (!app) return;
  const messaging = admin.messaging();

  const normalizedTokens = normalizeTokens(tokens);
  const grouped = splitTokensByPlatform(normalizedTokens);
  const baseData = sanitizeDataPayload({
    ...(data || {}),
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  });

  const sendMulticast = async (message) => {
    try {
      await messaging.sendEachForMulticast(message);
    } catch (error) {
      console.error("Failed to send push notifications:", error);
    }
  };

  if (grouped.web.length > 0) {
    await sendMulticast({
      tokens: grouped.web,
      data: baseData,
      webpush: {
        headers: {
          Urgency: data?.type === "call" ? "high" : "normal",
        },
      },
    });
  }

  if (grouped.android.length > 0) {
    await sendMulticast({
      tokens: grouped.android,
      notification: {
        title,
        body,
        image: imageUrl,
      },
      data: baseData,
      android: {
        priority: data?.type === "call" ? "high" : "normal",
      },
    });
  }

  if (grouped.ios.length > 0) {
    await sendMulticast({
      tokens: grouped.ios,
      notification: {
        title,
        body,
        image: imageUrl,
      },
      data: baseData,
    });
  }

  if (grouped.unknown.length > 0) {
    await sendMulticast({
      tokens: grouped.unknown,
      notification: {
        title,
        body,
        image: imageUrl,
      },
      data: baseData,
    });
  }
};
