import useAppStore from "@/store";
import { Navigate } from "react-router-dom";

const ProtectedRoute = ({ children, requireProfileSetup = true }) => {
  const user = useAppStore((state) => state.user);
  const isLoading = useAppStore((state) => state.isLoading);


  if (!user) {
    return <Navigate to="/auth" />;
  }

  if (requireProfileSetup && !user.profileSetup) {
    return <Navigate to="/profile" />;
  }

  return children;
};

export default ProtectedRoute;
