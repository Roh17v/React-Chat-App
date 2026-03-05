import { useEffect, useRef, memo } from "react";

const formatDuration = (s) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

/**
 * Self-contained call timer that only re-renders itself every second,
 * instead of causing the entire parent (VideoCallScreen/AudioCallScreen) to re-render.
 */
const toTimestamp = (value) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 0;
};

const toDurationSeconds = ({ startTimestamp, fallbackStartMs }) => {
  const sharedStart = toTimestamp(startTimestamp);
  if (sharedStart > 0) {
    return Math.max(0, Math.floor((Date.now() - sharedStart) / 1000));
  }
  return Math.max(0, Math.floor((Date.now() - fallbackStartMs) / 1000));
};

const areEqual = (prev, next) =>
  prev.connectionStatus === next.connectionStatus &&
  prev.className === next.className &&
  toTimestamp(prev.startTimestamp) === toTimestamp(next.startTimestamp);

const CallTimer = memo(({ connectionStatus, className, startTimestamp }) => {
  const textRef = useRef(null);
  const fallbackStartRef = useRef(0);
  const previousTextRef = useRef("00:00");

  useEffect(() => {
    const isConnected =
      connectionStatus === "connected" || connectionStatus === "completed";
    if (!isConnected) {
      fallbackStartRef.current = 0;
      previousTextRef.current = "00:00";
      if (textRef.current) textRef.current.textContent = "00:00";
      return;
    }

    if (!fallbackStartRef.current) {
      fallbackStartRef.current = Date.now();
    }

    const updateText = () => {
      const seconds = toDurationSeconds({
        startTimestamp,
        fallbackStartMs: fallbackStartRef.current,
      });
      const nextText = formatDuration(seconds);
      if (nextText === previousTextRef.current) return;
      previousTextRef.current = nextText;
      if (textRef.current) {
        textRef.current.textContent = nextText;
      }
    };

    updateText();
    const t = setInterval(updateText, 1000);
    return () => clearInterval(t);
  }, [connectionStatus, startTimestamp]);

  return (
    <span ref={textRef} className={className}>
      00:00
    </span>
  );
}, areEqual);

CallTimer.displayName = "CallTimer";

export default CallTimer;
