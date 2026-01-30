import React, { useState } from "react";
import Background from "@/assets/login2.png";
import Victory from "@/assets/victory.svg";
import { Tabs, TabsContent, TabsTrigger, TabsList } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HOST, LOGIN_ROUTE, SIGNUP_ROUTE } from "@/utils/constants";
import axios from "axios";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import useAppStore from "@/store";
import { FiMail, FiLock, FiEye, FiEyeOff } from "react-icons/fi";
const Auth = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const setUser = useAppStore((state) => state.setUser);
  const validateSignup = () => {
    if (!email.length) {
      toast.error("Email is required!");
      return false;
    }
    if (!password.length) {
      toast.error("Password is required!");
      return false;
    }
    if (!confirmPassword.length) {
      toast.error("Confirm Password is required.");
      return false;
    }
    if (confirmPassword != password) {
      toast.error("Confirm password and password are not same.");
      return false;
    }
    return true;
  };
  const validateEmail = (email) => {
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return regex.test(email);
  };
  const validateLogin = () => {
    if (!email.length) {
      toast.error("Email is required!");
      return false;
    }
    if (!validateEmail(email)) {
      toast.error("Invalid Email.");
      return false;
    }
    if (!password.length) {
      toast.error("Password is required!");
      return false;
    }
    return true;
  };
  const handleLogin = async (e) => {
    e.preventDefault();
    if (validateLogin()) {
      setIsLoading(true);
      try {
        const response = await axios.post(
          `${HOST}${LOGIN_ROUTE}`,
          {
            email,
            password,
          },
          { withCredentials: true }
        );
        if (response.status === 200) {
          setUser(response.data);
          toast.success("Logged In Successfully.");
          setTimeout(() => {
            navigate(response.data.profileSetup ? "/chats" : "/profile");
          }, 2000);
        }
      } catch (error) {
        toast.error(error.response?.data?.message || "Something went wrong");
        console.log(error);
      } finally {
        setIsLoading(false);
      }
    }
  };
  const handleSignup = async (e) => {
    e.preventDefault();
    if (validateSignup()) {
      setIsLoading(true);
      try {
        const response = await axios.post(
          `${HOST}${SIGNUP_ROUTE}`,
          {
            email,
            password,
          },
          { withCredentials: true }
        );
        if (response.status === 201) {
          setUser(response.data);
          toast.success("User registration successful.");
          setTimeout(() => {
            navigate("/profile");
          }, 2000);
        }
      } catch (error) {
        toast.error(error.response?.data?.message || "Something went wrong");
        console.log(error);
      } finally {
        setIsLoading(false);
      }
    }
  };
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      {/* Ambient background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      </div>
      <div className="relative w-full max-w-5xl grid lg:grid-cols-2 gap-8 items-center animate-fade-in">
        {/* Left side - Branding */}
        <div className="hidden lg:flex flex-col items-center justify-center p-8">
          <div className="relative">
            <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full" />
            <img
              src={Background}
              alt="Chat illustration"
              className="relative w-full max-w-md object-contain drop-shadow-2xl"
            />
          </div>
          <div className="mt-8 text-center space-y-4">
            <h2 className="text-3xl font-bold text-foreground">
              Connect Instantly
            </h2>
            <p className="text-foreground-secondary max-w-sm">
              Experience seamless communication with friends and colleagues in real-time
            </p>
          </div>
        </div>
        {/* Right side - Auth Form */}
        <div className="w-full max-w-md mx-auto">
          <div className="bg-background-secondary/80 backdrop-blur-xl border border-border rounded-3xl p-8 shadow-chat-lg">
            {/* Header */}
            <div className="text-center mb-8">
              <div className="inline-flex items-center gap-2 mb-4">
                <h1 className="text-3xl sm:text-4xl font-bold text-foreground">
                  Welcome
                </h1>
              </div>
              <p className="text-foreground-secondary text-sm sm:text-base">
                Sign in to continue your conversations
              </p>
            </div>
            {/* Tabs */}
            <Tabs defaultValue="login" className="w-full">
              <TabsList className="grid grid-cols-2 w-full bg-background-tertiary rounded-xl p-1 mb-6">
                <TabsTrigger
                  value="login"
                  className="rounded-lg py-2.5 text-sm font-medium transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md"
                >
                  Login
                </TabsTrigger>
                <TabsTrigger
                  value="signup"
                  className="rounded-lg py-2.5 text-sm font-medium transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md"
                >
                  Sign Up
                </TabsTrigger>
              </TabsList>
              {/* Login Form */}
              <TabsContent value="login" className="space-y-4 mt-0">
                <div className="space-y-4">
                  {/* Email Input */}
                  <div className="relative">
                    <FiMail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted" />
                    <Input
                      type="email"
                      placeholder="Email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="pl-12 h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
                    />
                  </div>
                  {/* Password Input */}
                  <div className="relative">
                    <FiLock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted" />
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="Password"
                      value={password}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleLogin(e);
                      }}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="pl-12 pr-12 h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
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
                  {/* Forgot Password Link */}
                  <div className="text-right">
                    <button
                      type="button"
                      className="text-sm text-primary hover:text-primary-hover transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                  {/* Login Button */}
                  <Button
                    onClick={handleLogin}
                    disabled={isLoading}
                    className="w-full h-12 bg-primary hover:bg-primary-hover text-primary-foreground rounded-xl font-semibold text-base shadow-chat-glow transition-all duration-200 hover:shadow-lg disabled:opacity-50"
                  >
                    {isLoading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                        Signing in...
                      </div>
                    ) : (
                      "Sign In"
                    )}
                  </Button>
                </div>
              </TabsContent>
              {/* Signup Form */}
              <TabsContent value="signup" className="space-y-4 mt-0">
                <div className="space-y-4">
                  {/* Email Input */}
                  <div className="relative">
                    <FiMail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted" />
                    <Input
                      type="email"
                      placeholder="Email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="pl-12 h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
                    />
                  </div>
                  {/* Password Input */}
                  <div className="relative">
                    <FiLock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted" />
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="pl-12 pr-12 h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
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
                  {/* Confirm Password Input */}
                  <div className="relative">
                    <FiLock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted" />
                    <Input
                      type={showConfirmPassword ? "text" : "password"}
                      placeholder="Confirm password"
                      value={confirmPassword}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSignup(e);
                      }}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      className="pl-12 pr-12 h-12 bg-background-tertiary border-border-subtle rounded-xl focus:border-primary focus:ring-primary/20 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground transition-colors"
                    >
                      {showConfirmPassword ? (
                        <FiEyeOff className="w-5 h-5" />
                      ) : (
                        <FiEye className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                  {/* Terms */}
                  <p className="text-xs text-foreground-muted text-center">
                    By signing up, you agree to our{" "}
                    <button type="button" className="text-primary hover:underline">
                      Terms of Service
                    </button>{" "}
                    and{" "}
                    <button type="button" className="text-primary hover:underline">
                      Privacy Policy
                    </button>
                  </p>
                  {/* Signup Button */}
                  <Button
                    onClick={handleSignup}
                    disabled={isLoading}
                    className="w-full h-12 bg-primary hover:bg-primary-hover text-primary-foreground rounded-xl font-semibold text-base shadow-chat-glow transition-all duration-200 hover:shadow-lg disabled:opacity-50"
                  >
                    {isLoading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                        Creating account...
                      </div>
                    ) : (
                      "Create Account"
                    )}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
            {/* Mobile branding */}
            <div className="lg:hidden mt-8 pt-6 border-t border-border-subtle">
              <p className="text-center text-foreground-muted text-sm">
                Experience seamless communication
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
export default Auth;