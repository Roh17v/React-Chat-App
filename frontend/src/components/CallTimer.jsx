import { useState, useEffect, memo } from "react";

const formatDuration = (s) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

/**
 * Self-contained call timer that only re-renders itself every second,
 * instead of causing the entire parent (VideoCallScreen/AudioCallScreen) to re-render.
 */
const CallTimer = memo(({ connectionStatus, className }) => {
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (connectionStatus === "connected" || connectionStatus === "completed") {
      const t = setInterval(() => setDuration((p) => p + 1), 1000);
      return () => clearInterval(t);
    }
  }, [connectionStatus]);

  return <span className={className}>{formatDuration(duration)}</span>;
});

CallTimer.displayName = "CallTimer";

export default CallTimer;
