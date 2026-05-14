import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HOST, FORGOT_PASSWORD_ROUTE, RESET_PASSWORD_ROUTE } from "@/utils/constants";
import axios from "axios";
import { toast } from "sonner";
import { FiLock, FiMail, FiEye, FiEyeOff } from "react-icons/fi";
import { Loader2, ShieldCheck, KeyRound } from "lucide-react";

const ForgotPassword = () => {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState(1); // 1: Enter email, 2: Enter OTP & New Password
  const [isLoading, setIsLoading] = useState(false);
  
  const navigate = useNavigate();

  const handleSendOtp = async (e) => {
    e.preventDefault();
    if (!email) {
      toast.error("Please enter your email.");
      return;
    }
    
    setIsLoading(true);
    try {
      const response = await axios.post(
        `${HOST}${FORGOT_PASSWORD_ROUTE}`,
        { email },
        { withCredentials: true }
      );
      
      if (response.status === 200) {
        toast.success("Password reset OTP sent to your email.");
        setStep(2);
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Something went wrong");
      console.log(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!otp || otp.length !== 6) {
      toast.error("Please enter a 6-digit OTP.");
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      toast.error("Password must be at least 6 characters.");
      return;
    }
    
    setIsLoading(true);
    try {
      const response = await axios.post(
        `${HOST}${RESET_PASSWORD_ROUTE}`,
        { email, otp, newPassword },
        { withCredentials: true }
      );
      
      if (response.status === 200) {
        toast.success("Password reset successfully! Please log in.");
        setTimeout(() => {
          navigate("/auth");
        }, 2000);
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Something went wrong");
      console.log(error);
    } finally {
      setIsLoading(false);
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
              {step === 1 ? (
                <KeyRound className="w-8 h-8 text-primary" strokeWidth={2} />
              ) : (
                <ShieldCheck className="w-8 h-8 text-primary" strokeWidth={2} />
              )}
            </div>
          </div>

          {/* Header */}
          <div className="text-center mb-6">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">
              {step === 1 ? "Forgot Password" : "Reset Password"}
            </h1>
            <p className="mt-2 text-sm text-foreground-secondary leading-relaxed">
              {step === 1
                ? "Enter your email to receive a password reset code."
                : `Enter the code sent to ${email} and your new password.`}
            </p>
          </div>

          {/* Form */}
          {step === 1 ? (
            <form onSubmit={handleSendOtp} className="space-y-4">
              <div className="relative">
                <FiMail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted pointer-events-none" />
                <Input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="pl-12 h-12 bg-background-tertiary border-border-subtle rounded-2xl focus-visible:border-primary focus-visible:ring-primary/20 transition-all"
                />
              </div>

              <Button
                type="submit"
                disabled={isLoading || !email}
                className="w-full h-12 rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-semibold shadow-chat-glow transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending Code...
                  </>
                ) : (
                  "Send Reset Code"
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div className="relative">
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
                  className="px-4 h-14 bg-background-tertiary border-border-subtle rounded-2xl focus-visible:border-primary focus-visible:ring-primary/20 transition-all text-center text-xl sm:text-2xl font-semibold tracking-[0.25em] sm:tracking-[0.5em] placeholder:text-foreground-muted/40 placeholder:tracking-[0.25em] sm:placeholder:tracking-[0.5em]"
                />
              </div>

              <div className="relative">
                <FiLock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted pointer-events-none" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="New Password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  className="pl-12 pr-12 h-12 bg-background-tertiary border-border-subtle rounded-2xl focus-visible:border-primary focus-visible:ring-primary/20 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground transition-colors"
                >
                  {showPassword ? (
                    <FiEyeOff className="w-5 h-5" />
                  ) : (
                    <FiEye className="w-5 h-5" />
                  )}
                </button>
              </div>

              <Button
                type="submit"
                disabled={isLoading || otp.length !== 6 || newPassword.length < 6}
                className="w-full h-12 rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-semibold shadow-chat-glow transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  "Reset Password"
                )}
              </Button>
            </form>
          )}

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

export default ForgotPassword;
