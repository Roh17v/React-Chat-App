import AudioCallScreen from "@/components/AudioCallScreen";
import VideoCallScreen from "@/components/VideoCallScreen";
import useAppStore from "@/store";

const CallContainer = () => {
  const { activeCall } = useAppStore();

  if (!activeCall) return null;

  if (activeCall.callType === "video") {
    return <VideoCallScreen />;
  }

  if (activeCall.callType === "audio") {
    return <AudioCallScreen />;
  }

  return null;
};

export default CallContainer;
