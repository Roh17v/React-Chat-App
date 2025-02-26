import React from "react";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import useAppStore from "@/store";
import { HOST, LOGIN_ROUTE, LOGOUT_ROUTE } from "@/utils/constants";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FiEdit2 } from "react-icons/fi";
import { useNavigate } from "react-router-dom";
import { IoPowerSharp } from "react-icons/io5";
import { toast } from "sonner";
import axios from "axios";

const ProfileInfo = () => {
  const user = useAppStore((state) => state.user);
  const setUser = useAppStore((state) => state.setUser);
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      const response = await axios.post(
        `${HOST}${LOGOUT_ROUTE}`,
        {},
        {
          withCredentials: "true",
        }
      );

      if (response.status === 200) {
        toast.success("Logged Out Successfully.");
        setUser(null);
        navigate("/auth");
      }
    } catch (error) {
      toast.error(error.response.data.message);
    }
  };

  return (
    <div className="absolute bottom-0 w-full bg-[#2a2b33] h-16 flex items-center justify-between px-6">
      <div className="flex items-center gap-3 mx-auto">
        <Avatar
          className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden border border-gray-500"
          style={{
            backgroundColor: `${user.color.bgColor}80`,
            color: `${user.color.textColor}`,
          }}
        >
          {user.image ? (
            <AvatarImage
              src={`${HOST}${user.image}`}
              alt="profile"
              className="object-cover w-full h-full"
            />
          ) : (
            <div className="uppercase flex items-center justify-center text-lg sm:text-xl font-semibold">
              {user.firstName ? user.firstName.charAt(0) : user.email.charAt(0)}
            </div>
          )}
        </Avatar>
        <p className="text-white text-sm sm:text-base font-medium whitespace-nowrap">
          {user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : "User"}
        </p>
      </div>

      <div className="flex justify-between">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger className="hover:bg-[#3a3b42] p-2 rounded-full transition">
              <FiEdit2
                className="text-gray-300 hover:text-purple-500 text-lg sm:text-xl cursor-pointer"
                onClick={() => navigate("/profile")}
              />
            </TooltipTrigger>
            <TooltipContent className="bg-[#1c1b21] text-white text-xs px-3 py-1 rounded-md border-none">
              Edit Profile
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger className="hover:bg-[#3a3b42] p-2 rounded-full transition">
              <IoPowerSharp
                className="text-red-500 text-lg sm:text-xl cursor-pointer"
                onClick={handleLogout}
              />
            </TooltipTrigger>
            <TooltipContent className="bg-[#1c1b21] text-white text-xs px-3 py-1 rounded-md border-none">
              Logout
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
};

export default ProfileInfo;
