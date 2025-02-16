import React from "react";
import useAppStore from "@/store";

const Profile = () => {
  const user = useAppStore((state) => state.user);
  return <div>{user.email}</div>;
};

export default Profile;
