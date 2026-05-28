import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import { SocketProvider } from "@/context/SocketContext";
import IncomingCallOverlay from "./components/IncomingCallOverlay";
import CallContainer from "./pages/call";
import axios from "axios";
import { Preferences } from "@capacitor/preferences";

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

createRoot(document.getElementById("root")).render(
  <SocketProvider>
    <BrowserRouter>
      <CallContainer />
      <App />
      <IncomingCallOverlay />
      <Toaster closeButton />
    </BrowserRouter>
  </SocketProvider>,
);
