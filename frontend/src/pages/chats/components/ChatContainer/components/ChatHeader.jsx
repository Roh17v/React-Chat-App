import React from "react";
import { RiCloseFill } from "react-icons/ri";

const ChatHeader = () => {
  return (
    <div className="h-[10vh] border-b-2 border-[#2f303b] flex items-center justify-between">
      <div className="flex gap-5 items-center">
        <div className="flex gap-4 items-center justify-center"></div>
        <div className="flex items-center justify-center gap-5">
          <button>
            <RiCloseFill className="text-3xl" /> 
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatHeader;
