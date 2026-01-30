import { animationDefaultOptions } from "@/lib/utils";
import React from "react";
import Lottie from "react-lottie";
import { FiMessageCircle, FiUsers, FiZap } from "react-icons/fi";
const EmptyChatContainer = () => {
  const features = [
    {
      icon: FiMessageCircle,
      title: "Real-time",
      description: "Instant message delivery with read receipts",
    },
    {
      icon: FiUsers,
      title: "Group Channels",
      description: "Create channels for team collaboration",
    },
    {
      icon: FiZap,
      title: "File Sharing",
      description: "Share images, documents and more",
    },
  ];
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-background relative overflow-hidden">
      {/* Ambient background effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/3 left-1/4 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
      </div>
      {/* Content */}
      <div className="relative z-10 flex flex-col items-center max-w-lg px-6 animate-fade-in">
        {/* Animation */}
        <div className="relative mb-6">
          <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full scale-75" />
          <Lottie
            isClickToPauseDisabled={true}
            height={180}
            width={180}
            options={animationDefaultOptions}
          />
        </div>
        {/* Welcome Text */}
        <div className="text-center space-y-3 mb-10">
          <h1 className="text-3xl sm:text-4xl font-bold text-foreground">
            Welcome to <span className="text-primary">Syncronus</span>
          </h1>
          <p className="text-foreground-secondary text-base sm:text-lg max-w-sm">
            Select a conversation from the sidebar or start a new chat to begin
            messaging
          </p>
        </div>
        {/* Feature Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-xl">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group flex flex-col items-center p-4 rounded-2xl bg-background-secondary/60 border border-border-subtle hover:border-primary/30 hover:bg-background-secondary transition-all duration-300"
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-3 group-hover:bg-primary/20 transition-colors">
                <feature.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-1">
                {feature.title}
              </h3>
              <p className="text-xs text-foreground-muted text-center leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
export default EmptyChatContainer;
