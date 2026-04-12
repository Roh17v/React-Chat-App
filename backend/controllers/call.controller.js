import { createError } from "../utils/error.js";
import { finalizeCallRecord } from "../services/callFinalize.service.js";

export const finalizeCall = async (req, res, next) => {
  try {
    const { callId, peerId, to, endedAt, reason, duration } = req.body || {};
    const requesterId = req.user?._id;
    const targetPeerId = peerId || to;

    if (!callId && !targetPeerId) {
      return next(createError(400, "callId or peerId is required."));
    }

    const result = await finalizeCallRecord({
      callId,
      requesterId,
      peerId: targetPeerId,
      endedAt,
      reason,
      duration,
    });

    if (!result.ok) {
      if (result.reason === "call_not_found") {
        return next(createError(404, "Call not found."));
      }
      if (result.reason === "forbidden") {
        return next(createError(403, "Not authorized to finalize this call."));
      }
      return next(createError(400, "Unable to finalize call."));
    }

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};

