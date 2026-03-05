import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import { SocketProvider } from "@/context/SocketContext";
import IncomingCallOverlay from "./components/IncomingCallOverlay";
import CallContainer from "./pages/call";

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
