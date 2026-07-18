import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import { SocketProvider } from "@/context/SocketContext";
import { OfflineProvider } from "@/offline";
import IncomingCallOverlay from "./components/IncomingCallOverlay";
import CallContainer from "./pages/call";
import axios from "axios";
import { Preferences } from "@capacitor/preferences";
import useAppStore from "@/store";

// Automatically inject native token in Authorization header for all API requests
axios.interceptors.request.use(
  async (config) => {
    try {
      const { value: token } = await Preferences.get({ key: "auth_token" });
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.error("Error setting native auth token header:", error);
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Global response interceptor to catch 401 Unauthorized errors (e.g. token expired)
// and automatically log the user out if the token dies while the app is running.
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response && error.response.status === 401) {
      console.log("Global Axios interceptor caught 401. Clearing auth state.");
      await Preferences.remove({ key: "auth_token" }).catch(() => {});
      await Preferences.remove({ key: "auth_user" }).catch(() => {});
      const state = useAppStore.getState();
      if (state && typeof state.logout === "function") {
        state.logout();
      }
      // If we are not already on auth page, redirect to auth.
      if (window.location.pathname !== "/auth") {
        window.location.href = "/auth";
      }
    }
    return Promise.reject(error);
  }
);

createRoot(document.getElementById("root")).render(
  <SocketProvider>
    <BrowserRouter>
      <OfflineProvider>
        <CallContainer />
        <App />
        <IncomingCallOverlay />
        <Toaster closeButton />
      </OfflineProvider>
    </BrowserRouter>
  </SocketProvider>,
);
