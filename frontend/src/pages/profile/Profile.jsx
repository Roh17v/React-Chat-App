import React, { useEffect } from "react";
import useAppStore from "@/store";
import { useState } from "react";
import { FiArrowLeft, FiCamera, FiTrash2, FiCheck } from "react-icons/fi";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import axios from "axios";
import { USER_ROUTES, HOST } from "@/utils/constants";
const Profile = () => {
  const navigate = useNavigate();
  const [image, setImage] = useState(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [hovered, setHovered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedColor, setSelectedColor] = useState({
    bgColor: "#ff007f",
    textColor: "#ff006e",
  });
  const [selectedFile, setSelectedFile] = useState(null);
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
    { bgColor: "#10b981", textColor: "#34d399" }, // Teal (matches primary)
    { bgColor: "#8b5cf6", textColor: "#a78bfa" }, // Purple
    { bgColor: "#f59e0b", textColor: "#fbbf24" }, // Amber
    { bgColor: "#ef4444", textColor: "#f87171" }, // Red
    { bgColor: "#3b82f6", textColor: "#60a5fa" }, // Blue
    { bgColor: "#ec4899", textColor: "#f472b6" }, // Pink
  ];
  const handleSave = async (e) => {
    e.preventDefault();
    if (!firstName) return toast.error("First Name is required.");
    if (!lastName) return toast.error("Last Name is required.");
    setIsLoading(true);
    const formData = new FormData();
    formData.append("firstName", firstName);
    formData.append("lastName", lastName);
    formData.append("color", JSON.stringify(selectedColor));
    formData.append("profileSetup", "true");
    if (selectedFile) {
      formData.append("image", selectedFile);
    }
    try {
      const response = await axios.patch(
        `${HOST}${USER_ROUTES}/${user.id}/profile`,
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );
      if (response.status === 200) {
        setUser(response.data);
        toast.success("Profile updated successfully.");
        navigate("/chats");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };
  const handleImageChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImage(e.target.result);
    };
    reader.readAsDataURL(file);
    setSelectedFile(file);
  };
  const handleRemoveImage = async () => {
    if (!user.image) {
      setImage(null);
      setSelectedFile(null);
      return;
    }
    try {
      const response = await axios.delete(
        `${HOST}${USER_ROUTES}/${user.id}/profile/image`,
        {
          withCredentials: true,
        }
      );
      if (response.status === 200) {
        toast.success("Profile picture removed successfully!");
        setUser({ ...user, image: null });
        setImage(null);
        setSelectedFile(null);
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Something went wrong");
    }
  };
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      {/* Ambient background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      </div>
      <div className="relative w-full max-w-lg animate-fade-in">
        {/* Back Button */}
        {user.profileSetup && (
          <button
            onClick={() => navigate("/chats")}
            className="absolute -top-12 left-0 flex items-center gap-2 text-foreground-secondary hover:text-foreground transition-colors group"
          >
            <FiArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
            <span className="text-sm font-medium">Back to chats</span>
          </button>
        )}
        {/* Profile Card */}
        <div className="bg-background-secondary/80 backdrop-blur-xl border border-border rounded-3xl overflow-hidden shadow-chat-lg">
          {/* Top accent */}
          <div className="h-1 bg-gradient-to-r from-primary via-primary to-transparent" />
          <div className="p-8">
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">
                {user.profileSetup ? "Edit Profile" : "Complete Your Profile"}
              </h1>
              <p className="text-foreground-secondary text-sm">
                {user.profileSetup
                  ? "Update your personal information"
                  : "Add your details to get started"}
              </p>
            </div>
            {/* Avatar Section */}
            <div className="flex justify-center mb-8">
              <div
                className="relative group cursor-pointer"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
              >
                <Avatar className="w-28 h-28 sm:w-32 sm:h-32 border-4 border-background-tertiary shadow-chat-lg transition-transform duration-200 group-hover:scale-105">
                  {image ? (
                    <AvatarImage
                      src={image}
                      alt="Profile"
                      className="object-cover"
                    />
                  ) : (
                    <AvatarFallback
                      style={{ backgroundColor: selectedColor.bgColor }}
                      className="text-3xl sm:text-4xl font-bold text-white"
                    >
                      {firstName ? firstName.charAt(0).toUpperCase() : user.email?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  )}
                </Avatar>
                {/* Hover Overlay */}
                <div
                  className={`absolute inset-0 rounded-full bg-background/80 backdrop-blur-sm flex items-center justify-center gap-3 transition-opacity duration-200 ${
                    hovered ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <input
                    type="file"
                    id="avatar-upload"
                    accept="image/*"
                    onChange={handleImageChange}
                    className="hidden"
                  />
                  <label
                    htmlFor="avatar-upload"
                    className="w-10 h-10 rounded-full bg-primary/20 hover:bg-primary flex items-center justify-center cursor-pointer transition-colors group/btn"
                  >
                    <FiCamera className="w-5 h-5 text-primary group-hover/btn:text-primary-foreground transition-colors" />
                  </label>
                  {image && (
                    <button
                      onClick={handleRemoveImage}
                      className="w-10 h-10 rounded-full bg-destructive/20 hover:bg-destructive flex items-center justify-center transition-colors group/btn"
                    >
                      <FiTrash2 className="w-5 h-5 text-destructive group-hover/btn:text-destructive-foreground transition-colors" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {/* Form Fields */}
            <div className="space-y-4 mb-8">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground-secondary">
                    First Name
                  </label>
                  <Input
                    placeholder="John"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground-secondary">
                    Last Name
                  </label>
                  <Input
                    placeholder="Doe"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
                  />
                </div>
              </div>
              {/* Email Display */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground-secondary">
                  Email
                </label>
                <div className="h-12 px-4 flex items-center bg-background-tertiary/50 border border-border-subtle rounded-xl text-foreground-muted">
                  {user.email}
                </div>
              </div>
            </div>
            {/* Color Picker */}
            <div className="mb-8">
              <label className="text-sm font-medium text-foreground-secondary block mb-3">
                Profile Color
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                {colors.map((color, index) => (
                  <button
                    key={index}
                    onClick={() => setSelectedColor(color)}
                    className="relative w-10 h-10 rounded-full transition-transform duration-200 hover:scale-110"
                    style={{ backgroundColor: color.bgColor }}
                  >
                    {selectedColor.bgColor === color.bgColor && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <FiCheck className="w-5 h-5 text-white drop-shadow-md" />
                      </div>
                    )}
                    <div
                      className={`absolute inset-0 rounded-full border-2 transition-opacity ${
                        selectedColor.bgColor === color.bgColor
                          ? "border-white opacity-100"
                          : "border-transparent opacity-0"
                      }`}
                    />
                  </button>
                ))}
              </div>
            </div>
            {/* Save Button */}
            <Button
              onClick={handleSave}
              disabled={isLoading}
              className="w-full h-12 bg-primary hover:bg-primary-hover text-primary-foreground rounded-xl font-semibold text-base shadow-chat-glow transition-all duration-200 hover:shadow-lg disabled:opacity-50"
            >
              {isLoading ? (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  Saving...
                </div>
              ) : (
                "Save Changes"
              )}
            </Button>
          </div>
        </div>
        {/* Setup Notice */}
        {!user.profileSetup && (
          <div className="mt-6 p-4 rounded-2xl bg-primary/10 border border-primary/20 text-center">
            <p className="text-sm text-foreground-secondary">
              <span className="text-primary font-medium">Almost there!</span> Complete your profile to start chatting
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
export default Profile;