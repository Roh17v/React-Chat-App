import axios from "axios";
import { CALL_FINALIZE_ROUTE } from "@/utils/constants";

const SOCKET_ACK_TIMEOUT_MS = 900;
const HTTP_TIMEOUT_MS = 2500;

const toPositiveSeconds = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const resolveDurationSeconds = ({ duration, callStartedAt, endedAt }) => {
  const explicitDuration = toPositiveSeconds(duration);
  if (explicitDuration !== null) return explicitDuration;

  if (!callStartedAt) return null;
  const startedAtMs = new Date(callStartedAt).getTime();
  const endedAtMs = new Date(endedAt).getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;
  if (endedAtMs < startedAtMs) return 0;
  return Math.floor((endedAtMs - startedAtMs) / 1000);
};

const buildFinalizePayload = ({
  to,
  peerId,
  callId,
  reason,
  endedAt,
  duration,
  callStartedAt,
}) => {
  const resolvedEndedAt = endedAt ? new Date(endedAt).toISOString() : new Date().toISOString();
  const resolvedDuration = resolveDurationSeconds({
    duration,
    callStartedAt,
    endedAt: resolvedEndedAt,
  });

  return {
    ...(to ? { to } : {}),
    ...(peerId ? { peerId } : {}),
    ...(callId ? { callId } : {}),
    ...(reason ? { reason } : {}),
    endedAt: resolvedEndedAt,
    ...(resolvedDuration !== null ? { duration: resolvedDuration } : {}),
  };
};

const emitFinalizeWithAck = (socket, payload) =>
  new Promise((resolve) => {
    if (!socket?.connected) {
      resolve({ ok: false, reason: "socket_disconnected" });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const timeoutId = window.setTimeout(() => {
      finish({ ok: false, reason: "socket_ack_timeout" });
    }, SOCKET_ACK_TIMEOUT_MS);

    try {
      socket.emit("call:finalize", payload, (ack = {}) => {
        if (ack?.ok) {
          finish({ ok: true, via: "socket", data: ack });
          return;
        }
        finish({ ok: false, reason: ack?.reason || "socket_nack", data: ack });
      });
    } catch {
      finish({ ok: false, reason: "socket_emit_failed" });
    }
  });

const finalizeWithHttp = async (payload) => {
  const response = await axios.post(CALL_FINALIZE_ROUTE, payload, {
    withCredentials: true,
    timeout: HTTP_TIMEOUT_MS,
  });
  const data = response?.data || {};
  if (data?.success || data?.ok) {
    return { ok: true, via: "http", data };
  }
  return { ok: false, reason: "http_nack", data };
};

export const finalizeCallReliable = async ({
  socket,
  to,
  peerId,
  callId,
  reason = "hangup",
  endedAt,
  duration,
  callStartedAt,
} = {}) => {
  if (!to && !peerId && !callId) {
    return { ok: false, reason: "invalid_finalize_payload" };
  }

  const payload = buildFinalizePayload({
    to,
    peerId,
    callId,
    reason,
    endedAt,
    duration,
    callStartedAt,
  });

  const socketResult = await emitFinalizeWithAck(socket, payload);
  if (socketResult.ok) {
    return socketResult;
  }

  try {
    const httpResult = await finalizeWithHttp(payload);
    if (httpResult.ok) {
      return httpResult;
    }
    return {
      ok: false,
      reason: httpResult.reason || socketResult.reason || "finalize_failed",
      socketReason: socketResult.reason,
      httpReason: httpResult.reason,
    };
  } catch {
    return {
      ok: false,
      reason: "http_finalize_failed",
      socketReason: socketResult.reason,
    };
  }
};

