export const CALL_VIDEO_SOURCE_CAMERA = "camera";
export const CALL_VIDEO_SOURCE_SCREEN = "screen";
export const CALL_VIDEO_SOURCE_OFF = "off";

export const normalizeCallMediaState = ({
  videoOff = false,
  videoSource,
  screenShareActive = false,
} = {}) => {
  const normalizedVideoOff = Boolean(videoOff);
  const normalizedVideoSource =
    typeof videoSource === "string" ? videoSource.toLowerCase() : "";

  let resolvedVideoSource = CALL_VIDEO_SOURCE_CAMERA;
  if (normalizedVideoOff || normalizedVideoSource === CALL_VIDEO_SOURCE_OFF) {
    resolvedVideoSource = CALL_VIDEO_SOURCE_OFF;
  } else if (
    normalizedVideoSource === CALL_VIDEO_SOURCE_SCREEN ||
    Boolean(screenShareActive)
  ) {
    resolvedVideoSource = CALL_VIDEO_SOURCE_SCREEN;
  }

  return {
    videoOff: resolvedVideoSource === CALL_VIDEO_SOURCE_OFF,
    videoSource: resolvedVideoSource,
    screenShareActive: resolvedVideoSource === CALL_VIDEO_SOURCE_SCREEN,
  };
};
