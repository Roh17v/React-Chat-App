import React, { useEffect } from "react";
import useAppStore from "@/store";
import { useState } from "react";
import { FaArrowLeft } from "react-icons/fa6";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FaTrash, FaPlus } from "react-icons/fa";
import axios from "axios";
import { USER_ROUTES, HOST } from "@/utils/constants";

const Profile = () => {
  const navigate = useNavigate();
  const [image, setImage] = useState(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [hovered, setHovered] = useState(false);
  const [selectedColor, setSelectedColor] = useState({
    bgColor: "#ff007f",
    textColor: "#ff006e",
  });
  const user = useAppStore((state) => state.user);
  const setUser = useAppStore((state) => state.setUser);

  useEffect(() => {
    setImage(user.image || null);
    setFirstName(user.firstName || "");
    setLastName(user.lastName || "");
    setSelectedColor(
      user.color || { bgColor: "#ff007f", textColor: "#ff006e" }
    );
  }, [user]);

  const colors = [
    { bgColor: "#ff007f", textColor: "#ff006e" },
    { bgColor: "#f4c542", textColor: "#ffd06a" },
    { bgColor: "#2a9d8f", textColor: "#06d6a0" },
    { bgColor: "#264653", textColor: "#4cc950" },
  ];

  const handleSave = async (e) => {
    e.preventDefault();
    if (!firstName) {
      return toast.error("Enter your First name.");
    }

    if (!lastName) {
      return toast.error("Enter your Last name.");
    }
    const reqData = { firstName, lastName };

    if (image) reqData.image = image;
    if (selectedColor) reqData.color = selectedColor;
    reqData.profileSetup = true;

    try {
      const response = await axios.patch(
        `${HOST}${USER_ROUTES}/${user.id}/profile`,
        reqData
      );

      console.log(response);

      if (response.status === 200) {
        return toast.success("Profile updated Successfully.");
      }
    } catch (error) {
      toast(error.response.data.message);
    }
  };
  return (
    <div className="flex items-center justify-center bg-[#1b1c24] w-full h-[100vh] relative">
      {/* Profile Setup Card */}
      <div className="flex flex-col gap-10 w-full max-w-xl p-6 rounded-md shadow-lg">
        <button
          onClick={() => navigate(-1)}
          className="text-white hover:text-gray-400"
        >
          <FaArrowLeft size={26} />
        </button>
        <div className="grid grid-cols-2 items-center">
          <div
            className="relative flex items-center justify-center h-full w-32 md:w-48"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <Avatar
              className={`h-32 w-32 md:w-48 md:h-48 rounded-full overflow-hidden border-2 border-[#ff007f] opacity-50 cursor-pointer`}
              style={{
                backgroundColor: `${selectedColor.bgColor}80`,
                color: `${selectedColor.textColor}`,
              }}
            >
              {image ? (
                <AvatarImage
                  src={image}
                  alt="profile"
                  className="object-cover w-full h-full bg-black"
                />
              ) : (
                <div
                  className={`uppercase h-full w-full flex items-center justify-center text-5xl font-semibold`}
                >
                  {firstName ? firstName.charAt(0) : user.email.charAt(0)}
                </div>
              )}
            </Avatar>
            {/* Hover Overlay*/}
            {hovered && (
              <div
                className={`absolute right-0 left-0 h-32 w-32 md:w-48 md:h-48 flex items-center justify-center bg-black/20 rounded-full ring-1 ring-white overflow-hidden transition-opacity duration-300`}
              >
                {image ? (
                  <FaTrash
                    aria-label="Add image"
                    className="text-white text-3xl lg:text-3xl cursor-pointer"
                  />
                ) : (
                  <FaPlus
                    aria-label="Delete image"
                    className="text-white text-3xl lg:text-3xl cursor-pointer"
                  />
                )}
              </div>
            )}
          </div>

          {/* Right: Inputs & Color Picker */}
          <div className="flex flex-col gap-4">
            <Input
              value={user.email}
              disabled
              className="w-full bg-gray-800 text-white/70"
            />

            <Input
              placeholder="First Name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full bg-gray-800 text-white"
            />
            <Input
              placeholder="Last Name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full bg-gray-800 text-white"
            />
            <div className="flex gap-4 mt-2">
              {colors.map((color, index) => (
                <div
                  key={index}
                  className={`w-10 h-10 rounded-full cursor-pointer border-2 transition duration-300 ${
                    selectedColor.bgColor === color.bgColor
                      ? "outline outline-white/50 outline-1"
                      : "border-transparent"
                  }`}
                  style={{ backgroundColor: color.bgColor }}
                  onClick={() => setSelectedColor(color)}
                ></div>
              ))}
            </div>
          </div>
        </div>

        {/* Save Button */}
        <Button
          className="w-full bg-purple-600 hover:bg-purple-700 text-md rounded-md py-6"
          onClick={handleSave}
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
};

export default Profile;
