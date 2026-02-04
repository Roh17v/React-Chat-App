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

export const sendPushToTokens = async ({ tokens, title, body, data }) => {
  if (!tokens || tokens.length === 0) return;
  const app = initFirebase();
  if (!app) return;;
  const messaging = admin.messaging();
  const message = {
    tokens,
    notification: {
      title,
      body,
    },
    data: data ? sanitizeDataPayload(data) : undefined,
  };

  try {
    await messaging.sendEachForMulticast(message);
  } catch (error) {
    console.error("Failed to send push notifications:", error);
  }
};