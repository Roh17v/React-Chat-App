import React, { useState, useEffect } from "react";
import { Preferences } from "@capacitor/preferences";
import { useLocation, useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HOST, VERIFY_EMAIL_ROUTE, RESEND_OTP_ROUTE } from "@/utils/constants";
import axios from "axios";
import { toast } from "sonner";
import useAppStore from "@/store";
import { FiLock, FiMail } from "react-icons/fi";
import { Loader2, ShieldCheck } from "lucide-react";

const VerifyEmail = () => {
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [canResend, setCanResend] = useState(true);

  const location = useLocation();
  const navigate = useNavigate();
  const setUser = useAppStore((state) => state.setUser);

  const email = location.state?.email;

  useEffect(() => {
    if (!email) {
      toast.error("No email found. Redirecting to signup.");
      navigate("/auth");
    }
  }, [email, navigate]);

  useEffect(() => {
    let timer;
    if (resendCooldown > 0 && !canResend) {
      timer = setInterval(() => {
        setResendCooldown((prev) => prev - 1);
      }, 1000);
    } else {
      setCanResend(true);
    }
    return () => clearInterval(timer);
  }, [resendCooldown, canResend]);

  const handleVerify = async (e) => {
    e.preventDefault();
    if (otp.length !== 6) {
      toast.error("Please enter a 6-digit OTP.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await axios.post(
        `${HOST}${VERIFY_EMAIL_ROUTE}`,
        { email, otp },
        { withCredentials: true }
      );

      if (response.status === 200) {
        if (response.data.token) {
          await Preferences.set({ key: "auth_token", value: response.data.token });
        }
        setUser(response.data);
        toast.success("Email verified successfully!");
        setTimeout(() => {
          navigate(response.data.profileSetup ? "/chats" : "/profile");
        }, 2000);
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Verification failed");
      console.log(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!canResend) return;

    try {
      const response = await axios.post(
        `${HOST}${RESEND_OTP_ROUTE}`,
        { email },
        { withCredentials: true }
      );

      if (response.status === 200) {
        toast.success("New OTP sent to your email.");
        setResendCooldown(60);
        setCanResend(false);
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to resend OTP");
      console.log(error);
    }
  };

  return (
    <div className="relative min-h-[100dvh] w-full flex items-center justify-center bg-background overflow-hidden px-4 py-8 safe-area-top safe-area-bottom">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 w-[28rem] h-[28rem] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-[28rem] h-[28rem] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md animate-scale-in">
        <div className="glass border border-border-subtle rounded-3xl shadow-chat-lg p-6 sm:p-8">
          {/* Icon */}
          <div className="flex justify-center mb-5">
            <div className="relative w-16 h-16 rounded-2xl bg-primary/15 flex items-center justify-center shadow-chat-glow">
              <ShieldCheck className="w-8 h-8 text-primary" strokeWidth={2} />
            </div>
          </div>

          {/* Header */}
          <div className="text-center mb-6">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">
              Verify your email
            </h1>
            <p className="mt-2 text-sm text-foreground-secondary leading-relaxed">
              We've sent a 6-digit code to
            </p>
            <p className="mt-1 text-sm font-medium text-primary break-all">
              {email}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="relative">
              <FiLock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted pointer-events-none hidden sm:block" />
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                required
                className="px-4 sm:px-12 h-14 bg-background-tertiary border-border-subtle rounded-2xl focus-visible:border-primary focus-visible:ring-primary/20 transition-all text-center text-xl sm:text-2xl font-semibold tracking-[0.25em] sm:tracking-[0.5em] placeholder:text-foreground-muted/40 placeholder:tracking-[0.25em] sm:placeholder:tracking-[0.5em]"
              />
            </div>

            <Button
              type="submit"
              disabled={isLoading || otp.length !== 6}
              className="w-full h-12 rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-semibold shadow-chat-glow transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                "Verify Email"
              )}
            </Button>

            {/* Resend */}
            <div className="text-center pt-2">
              <button
                type="button"
                onClick={handleResendOtp}
                disabled={!canResend}
                className={`text-sm font-medium transition-colors ${canResend
                    ? "text-primary hover:text-primary-hover cursor-pointer"
                    : "text-foreground-muted cursor-not-allowed"
                  }`}
              >
                {canResend
                  ? "Resend OTP"
                  : `Resend OTP in ${resendCooldown}s`}
              </button>
            </div>
          </form>

          {/* Footer hint */}
          <div className="mt-6 pt-5 border-t border-border-subtle">
            <p className="flex items-center justify-center gap-2 text-xs text-foreground-muted">
              <FiMail className="w-3.5 h-3.5" />
              Check your spam folder if you don't see the email
            </p>
          </div>
        </div>

        {/* Back link */}
        <div className="text-center mt-5">
          <button
            onClick={() => navigate("/auth")}
            className="text-sm text-foreground-secondary hover:text-foreground transition-colors"
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
};

export default VerifyEmail;
