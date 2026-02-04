import "./App.css";
import { Navigate, Route, Routes } from "react-router-dom";
import Auth from "./pages/auth/Auth";
import Chats from "./pages/chats";
import ProtectedRoute from "./components/ProtectedRoutes.jsx";
import Profile from "./pages/profile/Profile";
import useAppStore from "./store";
import { useEffect, useState } from "react";
import axios from "axios";
import { HOST } from "./utils/constants";
import { AUTH_ROUTES } from "./utils/constants";
import Loader from "./components/Loader";
import { initializePushNotifications } from "./utils/pushNotifications";

function App() {
  const checkAuth = useAppStore((state) => state.checkAuth);
  const [isLoading, setIsLoading] = useState(true);
  const setUser = useAppStore((state) => state.setUser);
  const user = useAppStore((state) => state.user);

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
