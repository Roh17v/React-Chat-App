import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ChatLogo from "@/assets/chat-logo.svg";

/**
 * AuthSplash — shown while auth is being checked.
 *
 * Props:
 *  authReady {boolean} — set to true once the auth check has fully resolved.
 *  onDone    {function} — called after the exit animation finishes so the
 *                         parent can unmount this overlay.
 */
const AuthSplash = ({ authReady = false, onDone }) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (authReady) {
      const timer = setTimeout(() => setVisible(false), 500);
      return () => clearTimeout(timer);
    }
  }, [authReady]);

  return (
    <AnimatePresence onExitComplete={onDone}>
      {visible && (
        <motion.div
          key="auth-splash"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="fixed inset-0 bg-background z-[9999] flex items-center justify-center overflow-hidden"
        >
          {/* Logo — centered icon only (no green tile / outer strip) */}
          <motion.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
            className="flex items-center justify-center"
          >
            <img
              src={ChatLogo}
              alt=""
              className="w-16 h-16 drop-shadow-lg"
            />
          </motion.div>

          {/* Shimmer progress bar — bottom */}
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-40 h-[2px] bg-border rounded-full overflow-hidden">
            <motion.div
              className="h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent rounded-full"
              animate={{ x: ["-100%", "300%"] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AuthSplash;
