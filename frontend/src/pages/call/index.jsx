import { Suspense, lazy } from "react";
import useAppStore from "@/store";

const AudioCallScreen = lazy(() => import("@/components/AudioCallScreen"));
const VideoCallScreen = lazy(() => import("@/components/VideoCallScreen"));

const CallContainer = () => {
  const { activeCall } = useAppStore();

  if (!activeCall) return null;

  if (activeCall.callType === "video") {
    return (
      <Suspense fallback={null}>
        <VideoCallScreen />
      </Suspense>
    );
  }

  if (activeCall.callType === "audio") {
    return (
      <Suspense fallback={null}>
        <AudioCallScreen />
      </Suspense>
    );
  }

  return null;
};

export default CallContainer;
