import "./App.css";
import { Navigate, Route, Routes } from "react-router-dom";
import Auth from "./pages/auth/Auth";
import Chats from "./pages/chats/Chats";
import ProtectedRoute from "./components/ProtectedRoutes.jsx";
import Profile from "./pages/profile/Profile";

function App() {
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
