import * as crypto from "crypto";

const generateTurnCredentials = (secret, realm, ttl = 3600) => {
  const unixTimeStamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${unixTimeStamp}:${crypto.randomBytes(8).toString("hex")}`;

  const hmac = crypto.createHmac("sha1", secret);
  hmac.update(username);
  const password = hmac.digest("base64");

  return {
    iceServers: [
      {
        urls: "stun:165.22.215.16:3478",
      },
      {
        urls: [
          "stun:165.22.215.16:3478",
          "turn:165.22.215.16:3478?transport=udp",
          "turn:165.22.215.16:3478?transport=tcp",
          "turns:165.22.215.16:5349?transport=tcp",
        ],
        username,
        credential: password,
      },
    ],
  };
};

export const getTurnCredentials = (req, res) => {
  const secret = process.env.TURN_SECRET;
  const realm = req.hostname || "165.22.215.16";

  if (!secret) {
    return res.status(500).json({
      success: false,
      message: "TURN_SECRET is not configured",
    });
  }

  const credentials = generateTurnCredentials(secret, realm);

  res.status(200).json({
    success: true,
    ...credentials,
  });
};
