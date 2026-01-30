import React, { useState } from "react";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";
import { HOST, LOGOUT_ROUTE } from "@/utils/constants";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FiEdit2 } from "react-icons/fi";
import { useNavigate } from "react-router-dom";
import { IoPowerSharp, IoCloseSharp } from "react-icons/io5";
import { toast } from "sonner";
import axios from "axios";

const ProfileInfo = () => {
  const user = useAppStore((state) => state.user);
  const setUser = useAppStore((state) => state.setUser);
  const navigate = useNavigate();
  const [showAvatarPreview, setShowAvatarPreview] = useState(false);

  const handleLogout = async () => {
    try {
      const response = await axios.post(
        `${HOST}${LOGOUT_ROUTE}`,
        {},
        { withCredentials: true },
      );

      if (response.status === 200) {
        toast.success("Logged out successfully");
        setUser(null);
        navigate("/auth");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Something went wrong");
    }
  };

  const getDisplayName = () => {
    if (user?.firstName && user?.lastName) {
      return `${user.firstName} ${user.lastName}`;
    }
    return user?.email || "User";
  };

  const getAvatarFallback = () => {
    return user?.firstName
      ? user.firstName.charAt(0).toUpperCase()
      : user?.email?.charAt(0).toUpperCase() || "U";
  };
  console.log(user);

  return (
    <>
      <div className="flex items-center justify-between p-3 sm:p-4">
        {/* User Info */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setShowAvatarPreview(true)}
            className="relative flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar rounded-full transition-transform active:scale-95"
          >
            <Avatar className="h-10 w-10 sm:h-11 sm:w-11">
              {user?.image ? (
                <AvatarImage
                  src={user.image}
                  alt="avatar"
                  className="object-cover"
                />
              ) : (
                /* Moved style here and removed bg-primary */
                <div
                  className="flex h-full w-full items-center justify-center rounded-full font-semibold text-base"
                  style={{
                    backgroundColor: `${user.color.bgColor}80`, // 50% opacity hex
                    color: user.color.textColor,
                  }}
                >
                  {getAvatarFallback()}
                </div>
              )}
            </Avatar>
            {/* Online indicator */}
            <span className="status-dot online" />
          </button>

          <div className="min-w-0">
            <p className="text-foreground font-medium text-sm truncate max-w-[120px] sm:max-w-[150px]">
              {getDisplayName()}
            </p>
            <p className="text-foreground-muted text-xs">Online</p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => navigate("/profile")}
                  className="touch-target flex items-center justify-center rounded-full text-foreground-secondary hover:text-primary hover:bg-accent transition-all duration-200 active:scale-95"
                >
                  <FiEdit2 className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="bg-popover text-popover-foreground border-border">
                Edit Profile
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleLogout}
                  className="touch-target flex items-center justify-center rounded-full text-foreground-secondary hover:text-destructive hover:bg-destructive/10 transition-all duration-200 active:scale-95"
                >
                  <IoPowerSharp className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="bg-popover text-popover-foreground border-border">
                Logout
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Avatar Preview Modal */}
      {showAvatarPreview && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm animate-fade-in"
          onClick={() => setShowAvatarPreview(false)}
        >
          <div
            className="relative animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {user?.image ? (
              <img
                src={user.image}
                alt={getDisplayName()}
                className="max-w-[85vw] max-h-[70vh] sm:max-w-[400px] sm:max-h-[400px] rounded-2xl object-cover shadow-chat-lg"
              />
            ) : (
              <div className="w-64 h-64 sm:w-80 sm:h-80 rounded-2xl bg-primary flex items-center justify-center shadow-chat-lg">
                <span className="text-primary-foreground text-7xl sm:text-8xl font-bold">
                  {getAvatarFallback()}
                </span>
              </div>
            )}

            {/* Name overlay */}
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent rounded-b-2xl">
              <p className="text-foreground text-lg sm:text-xl font-semibold text-center">
                {getDisplayName()}
              </p>
            </div>
          </div>

          {/* Close button */}
          <button
            onClick={() => setShowAvatarPreview(false)}
            className="absolute top-4 right-4 sm:top-6 sm:right-6 touch-target rounded-full bg-background-secondary/80 text-foreground hover:bg-background-tertiary transition-colors"
          >
            <IoCloseSharp className="w-6 h-6" />
          </button>
        </div>
      )}
    </>
  );
};

export default ProfileInfo;
