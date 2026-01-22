import { useRef } from "react";
import axios from "axios";
import { GET_TURN_CREDENTIALS } from "@/utils/constants";

const usePeerConnection = () => {
  const pcRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());

  // UPDATED: Now accepts 'onTrack' callback
  const createPeerConnection = async (onIceCandidate, onTrack) => {
    let config = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };

    try {
      const response = await axios.get(GET_TURN_CREDENTIALS, {
        withCredentials: true,
      });
      if (response.data.success && response.data.iceServers) {
        config.iceServers = response.data.iceServers;
      }
    } catch (error) {
      console.error("Error fetching ICE servers:", error);
    }

    const pc = new RTCPeerConnection(config);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) onIceCandidate(event.candidate);
    };

    // FIX: Single source of truth for Track Handling
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      
      // 1. Update the Ref (for internal logic)
      event.streams[0].getTracks().forEach((track) => {
        remoteStreamRef.current.addTrack(track);
      });

      // 2. Trigger the React State update (for UI)
      if (onTrack) {
        onTrack(remoteStream);
      }
    };

    return pc;
  };

  const addLocalTracks = (stream) => {
    if (!pcRef.current || !stream) return;
    stream.getTracks().forEach((track) => {
      const senders = pcRef.current.getSenders();
      const exists = senders.find((s) => s.track === track);
      if (!exists) {
        pcRef.current.addTrack(track, stream);
      }
    });
  };

  const closeConnection = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    remoteStreamRef.current = new MediaStream();
  };

  return {
    pcRef,
    remoteStreamRef,
    createPeerConnection,
    addLocalTracks,
    closeConnection,
  };
};

export default usePeerConnection;