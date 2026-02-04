import "./App.css";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import Auth from "./pages/auth/Auth";
import Chats from "./pages/chats";
import ProtectedRoute from "./components/ProtectedRoutes.jsx";
import Profile from "./pages/profile/Profile";
import useAppStore from "./store";
import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { HOST } from "./utils/constants";
import { AUTH_ROUTES } from "./utils/constants";
import Loader from "./components/Loader";
import { initializePushNotifications } from "./utils/pushNotifications";
import { useSocket } from "./context/SocketContext";

function App() {
  const checkAuth = useAppStore((state) => state.checkAuth);
  const [isLoading, setIsLoading] = useState(true);
  const setUser = useAppStore((state) => state.setUser);
  const user = useAppStore((state) => state.user);
  const directMessagesContacts = useAppStore(
    (state) => state.directMessagesContacts,
  );
  const channels = useAppStore((state) => state.channels);
  const setSelectedChatType = useAppStore((state) => state.setSelectedChatType);
  const setSelectedChatData = useAppStore((state) => state.setSelectedChatData);
  const pendingNotification = useAppStore(
    (state) => state.pendingNotification,
  );
  const setPendingNotification = useAppStore(
    (state) => state.setPendingNotification,
  );
  const clearPendingNotification = useAppStore(
    (state) => state.clearPendingNotification,
  );
  const setIncomingCall = useAppStore((state) => state.setIncomingCall);
  const clearIncomingCall = useAppStore((state) => state.clearIncomingCall);
  const setActiveCall = useAppStore((state) => state.setActiveCall);
  const incomingCall = useAppStore((state) => state.incomingCall);
  const activeCall = useAppStore((state) => state.activeCall);
  const navigate = useNavigate();
  const location = useLocation();
  const { socket } = useSocket();

  useEffect(() => {
    const checkAuth = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get(`${HOST}${AUTH_ROUTES}/me`, {
          withCredentials: true,
        });

        if (response.status === 200 && response.data) {
          setUser(response.data);
        } else {
          setUser(null);
        }
      } catch (error) {
        console.log("Error checking user!", error);
        setUser(null);
      } finally {
        setIsLoading(false);
        console.log(useAppStore.getState().user);
      }
    };

    checkAuth();
  }, []);

  const handleNotificationQuery = useCallback(
    (search) => {
      const params = new URLSearchParams(search);
      if (params.size === 0) return;

    const type = params.get("type") || "";
    const chatType = params.get("chatType") || "";
    const chatId = params.get("chatId") || "";
    const callId = params.get("callId") || "";
    const callerId = params.get("callerId") || "";
    const callType = params.get("callType") || "";
    const callerName = params.get("callerName") || "";
    const callerImage = params.get("callerImage") || "";
    const callerEmail = params.get("callerEmail") || "";
    const callAction = params.get("callAction") || "";

    const inferredType =
      type || (callId ? "call" : chatId ? "message" : "");

      if (inferredType) {
        setPendingNotification({
          type: inferredType,
          chatType,
          chatId,
          callId,
          callerId,
          callType,
          callerName,
          callerImage,
          callerEmail,
          callAction,
        });
        window.history.replaceState({}, "", window.location.pathname);
      }
    },
    [setPendingNotification],
  );

  useEffect(() => {
    handleNotificationQuery(window.location.search);
  }, [handleNotificationQuery]);

  useEffect(() => {
    handleNotificationQuery(location.search);
  }, [location.search, handleNotificationQuery]);

  useEffect(() => {
    let cleanup = () => {};
    if (user) {
      initializePushNotifications()
      .then((teardown) => {
        cleanup = teardown || (() => {});
      })
      .catch((error) => {
        console.error("Failed to initialize push notifications:", error);
      });
    }

    return () => cleanup();
  }, [user]);

  useEffect(() => {
    if (!pendingNotification || !user) return;

    if (pendingNotification.type === "call") {
      if (!socket) return;
      const callId = pendingNotification.callId;
      const callerId =
        pendingNotification.callerId || pendingNotification.chatId || "";
      const callType = pendingNotification.callType || "audio";
      const contactMatch = callerId
        ? directMessagesContacts?.find((item) => item._id === callerId)
        : null;
      const resolvedCallerName =
        pendingNotification.callerName ||
        `${contactMatch?.firstName || ""} ${contactMatch?.lastName || ""}`.trim() ||
        contactMatch?.email ||
        "Unknown User";
      const resolvedCallerImage =
        pendingNotification.callerImage || contactMatch?.image || "";
      const resolvedCallerEmail =
        pendingNotification.callerEmail || contactMatch?.email || "";

      if (!callId && !callerId) {
        clearPendingNotification();
        return;
      }

      if (pendingNotification.callAction === "reject") {
        socket.emit("call:reject", { callId, callerId });
        clearIncomingCall();
        clearPendingNotification();
        return;
      }

      if (pendingNotification.callAction === "accept") {
        socket.emit("call:accept", { callId, callerId });
        setActiveCall({
          callId,
          otherUserId: callerId,
          otherUserName: resolvedCallerName,
          otherUserImage: resolvedCallerImage,
          callType,
          isCaller: false,
        });
        clearIncomingCall();
        clearPendingNotification();
        if (window.location.pathname !== "/chats") {
          navigate("/chats", { replace: true });
        }
        return;
      }

      setIncomingCall({
        callId,
        callerId,
        callType,
        callerName: resolvedCallerName,
        callerImage: resolvedCallerImage,
        callerEmail: resolvedCallerEmail,
      });
      clearPendingNotification();
      if (window.location.pathname !== "/chats") {
        navigate("/chats", { replace: true });
      }
      return;
    }

    if (!pendingNotification.chatId) {
      clearPendingNotification();
      return;
    }

    const resolvedChatType =
      pendingNotification.chatType ||
      (pendingNotification.type === "channel-message"
        ? "channel"
        : "contact");

    if (resolvedChatType === "channel") {
      const channel = channels?.find(
        (item) => item._id === pendingNotification.chatId,
      );
      if (!channel) return;
      setSelectedChatType("channel");
      setSelectedChatData(channel);
      clearPendingNotification();
      if (window.location.pathname !== "/chats") {
        navigate("/chats", { replace: true });
      }
      return;
    }

    const contact = directMessagesContacts?.find(
      (item) => item._id === pendingNotification.chatId,
    );
    if (!contact) return;
    setSelectedChatType("contact");
    setSelectedChatData(contact);
    clearPendingNotification();
    if (window.location.pathname !== "/chats") {
      navigate("/chats", { replace: true });
    }
  }, [
    pendingNotification,
    user,
    socket,
    channels,
    directMessagesContacts,
    setSelectedChatType,
    setSelectedChatData,
    setIncomingCall,
    clearIncomingCall,
    setActiveCall,
    clearPendingNotification,
    navigate,
  ]);

  useEffect(() => {
    if (!directMessagesContacts?.length) return;

    const getDisplayName = (contact) =>
      `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() ||
      contact?.email ||
      "Unknown User";

    if (
      incomingCall &&
      (!incomingCall.callerName || incomingCall.callerName === "Unknown User")
    ) {
      const match = directMessagesContacts.find(
        (item) => item._id === incomingCall.callerId,
      );
      if (match) {
        setIncomingCall({
          ...incomingCall,
          callerName: getDisplayName(match),
          callerImage: incomingCall.callerImage || match.image || "",
          callerEmail: incomingCall.callerEmail || match.email || "",
        });
      }
    }

    if (
      activeCall &&
      !activeCall.isCaller &&
      (!activeCall.otherUserName || activeCall.otherUserName === "Unknown User")
    ) {
      const match = directMessagesContacts.find(
        (item) => item._id === activeCall.otherUserId,
      );
      if (match) {
        setActiveCall({
          ...activeCall,
          otherUserName: getDisplayName(match),
          otherUserImage: activeCall.otherUserImage || match.image || "",
        });
      }
    }
  }, [
    directMessagesContacts,
    incomingCall,
    activeCall,
    setIncomingCall,
    setActiveCall,
  ]);

  if (isLoading) return <Loader />;

  return (
    <Routes>
      <Route path="/auth" element={<Auth />} />

      <Route
        path="/profile"
        element={
          <ProtectedRoute requireProfileSetup={false}>
            <Profile />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chats"
        element={
          <ProtectedRoute requireProfileSetup={true}>
            <Chats />
          </ProtectedRoute>
        }
      ></Route>

      <Route path="*" element={<Navigate to="/auth" />} />
    </Routes>
  );
}

export default App;
