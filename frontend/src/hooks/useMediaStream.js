import { useCallback, useRef } from "react";

const useMediaStream = () => {
  const localStreamRef = useRef(null);

  const startMedia = useCallback(async (type = "audio") => {
    if (localStreamRef.current) return localStreamRef.current;

    const constraints =
      type === "video" ? { video: true, audio: true } : { audio: true };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;
    return stream;
  }, []);

  const stopMedia = useCallback(() => {
    if (!localStreamRef.current) return;

    localStreamRef.current.getTracks().forEach((track) => {
      track.stop();
    });

    localStreamRef.current = null;
  }, []);

  return {
    localStreamRef,
    startMedia,
    stopMedia,
  };
};

export default useMediaStream;
