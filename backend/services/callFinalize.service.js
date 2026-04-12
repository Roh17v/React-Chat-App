import mongoose from "mongoose";
import Call from "../models/call.model.js";

const normalizeId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return value._id.toString();
  return value.toString();
};

const buildCallQuery = (callId) => {
  if (!callId) return null;
  const isObjectId = mongoose.Types.ObjectId.isValid(callId);
  if (isObjectId) {
    return { $or: [{ _id: callId }, { callId }] };
  }
  return { callId };
};

const resolveFinalStatus = (reason, currentStatus) => {
  if (currentStatus && currentStatus !== "ongoing") return currentStatus;
  if (reason === "rejected") return "rejected";
  if (reason === "missed" || reason === "no_answer") return "missed";
  return "completed";
};

const resolveEndedBy = (requesterId, call) => {
  const normalizedRequesterId = normalizeId(requesterId);
  if (!normalizedRequesterId || !call) return "system";

  const callerId = normalizeId(call.callerId);
  const receiverId = normalizeId(call.receiverId);
  if (normalizedRequesterId === callerId) return "caller";
  if (normalizedRequesterId === receiverId) return "receiver";
  return "system";
};

const computeDurationSeconds = (call, endedAtDate, providedDuration) => {
  const parsedProvidedDuration = Number(providedDuration);
  if (
    Number.isFinite(parsedProvidedDuration) &&
    parsedProvidedDuration >= 0
  ) {
    return Math.floor(parsedProvidedDuration);
  }

  if (call?.connectedAt) {
    return Math.max(
      0,
      Math.floor((endedAtDate.getTime() - new Date(call.connectedAt).getTime()) / 1000),
    );
  }

  return 0;
};

const parseEndedAt = (rawEndedAt, call) => {
  const parsed = rawEndedAt ? new Date(rawEndedAt) : null;
  const hasValidEndedAt = parsed && !Number.isNaN(parsed.getTime());
  let endedAtDate = hasValidEndedAt ? parsed : new Date();

  if (call?.startedAt) {
    const startedAt = new Date(call.startedAt);
    if (endedAtDate.getTime() < startedAt.getTime()) {
      endedAtDate = new Date();
    }
  }

  return endedAtDate;
};

export const finalizeCallRecord = async ({
  callId,
  requesterId,
  peerId,
  endedAt,
  reason = "hangup",
  duration,
} = {}) => {
  const normalizedCallId = normalizeId(callId);
  const normalizedRequesterId = normalizeId(requesterId);
  const normalizedPeerId = normalizeId(peerId);

  let call = null;
  if (normalizedCallId) {
    const query = buildCallQuery(normalizedCallId);
    call = query ? await Call.findOne(query) : null;
  } else if (normalizedRequesterId && normalizedPeerId) {
    call = await Call.findOne({
      status: "ongoing",
      endedAt: null,
      $or: [
        { callerId: normalizedRequesterId, receiverId: normalizedPeerId },
        { callerId: normalizedPeerId, receiverId: normalizedRequesterId },
      ],
    })
      .sort({ connectedAt: -1, startedAt: -1 })
      .exec();
  }

  if (!call) {
    return { ok: false, reason: "call_not_found" };
  }

  const callerId = normalizeId(call.callerId);
  const receiverId = normalizeId(call.receiverId);
  const isRequesterParticipant =
    !normalizedRequesterId ||
    normalizedRequesterId === callerId ||
    normalizedRequesterId === receiverId;
  if (!isRequesterParticipant) {
    return { ok: false, reason: "forbidden" };
  }

  const resolvedCallId = normalizeId(call._id) || normalizeId(call.callId);
  const alreadyFinalized = Boolean(call.endedAt) || call.status !== "ongoing";
  if (alreadyFinalized) {
    return {
      ok: true,
      callId: resolvedCallId,
      alreadyFinalized: true,
      endedAt: call.endedAt ? new Date(call.endedAt).getTime() : null,
      duration: Number(call.duration) || 0,
      status: call.status,
      reason: call.endReason || reason,
      endedBy: call.endedBy || resolveEndedBy(normalizedRequesterId, call),
    };
  }

  const endedAtDate = parseEndedAt(endedAt, call);
  const finalDuration = computeDurationSeconds(call, endedAtDate, duration);
  const endedBy = resolveEndedBy(normalizedRequesterId, call);
  const finalStatus = resolveFinalStatus(reason, call.status);

  call.endedAt = endedAtDate;
  call.duration = finalDuration;
  call.status = finalStatus;
  call.endedBy = endedBy;
  call.endReason = reason || "hangup";
  await call.save();

  return {
    ok: true,
    callId: resolvedCallId,
    alreadyFinalized: false,
    endedAt: endedAtDate.getTime(),
    duration: finalDuration,
    status: finalStatus,
    reason: call.endReason,
    endedBy,
  };
};

