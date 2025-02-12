import { useState } from "react";
import { Button } from "@/components/ui/button";

import "./App.css";
import { Navigate, Route, Routes } from "react-router-dom";
import Auth from "./pages/auth";
import Chats from "./pages/chat";
import Profile from "./pages/profile";

function App() {
  const [count, setCount] = useState(0);

  return (
    <Routes>
      <Route path="/auth" element={<Auth />}></Route>
      <Route path="/chats" element={<Chats />}></Route>
      <Route path="/profile" element={<Profile />}></Route>

      <Route path="*" element={<Navigate to="/auth" />}></Route>
    </Routes>
  );
}

export default App;
