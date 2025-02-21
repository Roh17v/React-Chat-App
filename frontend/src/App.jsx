import "./App.css";
import { Navigate, Route, Routes } from "react-router-dom";
import Auth from "./pages/auth/Auth";
import Chats from "./pages/chats/Chats";
import ProtectedRoute from "./components/ProtectedRoutes.jsx";
import Profile from "./pages/profile/Profile";
import useAppStore from "./store";
import { useEffect, useState } from "react";
import axios from "axios";
import { HOST } from "./utils/constants";
import { AUTH_ROUTES } from "./utils/constants";

function App() {
  const checkAuth = useAppStore((state) => state.checkAuth);
  const [isLoading, setIsLoading] = useState(true);
  const setUser = useAppStore((state) => state.setUser);

  useEffect(() => {
    const checkAuth = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get(`${HOST}${AUTH_ROUTES}/me`, {
          withCredentials: true,
        });

        if (response.status === 200 && response.data) {
          setUser(response.data);
          4;
        } else {
          setUser(null);
        }
      } catch (error) {
        console.log("Error checking user!", error);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  if (isLoading) return <div>Loading...</div>;

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
