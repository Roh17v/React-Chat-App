import React, { useState } from "react";
import Background from "@/assets/login2.png";
import Victory from "@/assets/victory.svg";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { TabsList } from "@radix-ui/react-tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HOST, LOGIN_ROUTE, SIGNUP_ROUTE } from "@/utils/constants";
import axios from "axios";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import useAppStore from "@/store";

const Auth = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
      toast.error("Invaild Email.");
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
      try {
        const response = await axios.post(
          `${HOST}${LOGIN_ROUTE}`,
          {
            email,
            password,
          },
          { withCredentials: true }
        );
        console.log(response.data);

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
      }
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (validateSignup()) {
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

        console.log(response.data);
      } catch (error) {
        toast.error(error.response?.data?.message || "Something went wrong");
        console.log(error);
      }
    }
  };

  return (
    <div className="flex justify-center items-center h-[100vh]">
      <div className="h-[80vh] w-[80vw] text-opacity-90 md:w-[90vw] lg:w-[70vw] xl:w[60vw] bg-white border-white border-2 rounded-2xl shadow-2xl flex items-center justify-center">
        <div className="flex items-center justify-center">
          <div className="flex justify-center items-center flex-col">
            <div className="flex justify-center items-center">
              <h1 className="text-4xl font-bold md:text-6xl">Welcome</h1>
              <img src={Victory} alt="Victory emoji" className="h-[100px]" />
            </div>
            <p className="text-center">
              Fill in the details to get started with the best chat app!
            </p>
            <div className="flex items-center justify-center w-full flex-row">
              <Tabs className="w-4/5" defaultValue="login">
                <TabsList className="bg-transparent rounded-none min-w-full flex flex-row">
                  <TabsTrigger
                    value="login"
                    className="data-[state=active]:bg-transparent text-black text-opacity-90 data-[state=inactive]:text-gray-500 data-[state=inactive]:opacity-70 
                    data-[state=unactive]:text-opacity-50
                    border-b-2 rounded-none w-full data[state=active]:text-black data[state=active]:font-semibold data-[state=active]:border-b-purple-500 p-3 transition-all duration-300"
                  >
                    Login
                  </TabsTrigger>
                  <TabsTrigger
                    value="signup"
                    className="data-[state=active]:bg-transparent text-black text-opacity-90 data-[state=inactive]:text-gray-500 data-[state=inactive]:opacity-70 
                    data-[state=unactive]:text-opacity-50
                    border-b-2 rounded-none w-full data[state=active]:text-black data[state=active]:font-semibold data-[state=active]:border-b-purple-500 p-3 transition-all duration-300"
                  >
                    Signup
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="login" className="flex flex-col gap-5 mt-5">
                  <Input
                    placeholder="Email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="rounded-full"
                  />
                  <Input
                    placeholder="Password"
                    type="password"
                    value={password}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLogin(e);
                    }}
                    onChange={(e) => setPassword(e.target.value)}
                    className="rounded-full"
                    required
                  />
                  <Button
                    className="rounded-full p-6 w-full"
                    onClick={handleLogin}
                  >
                    Login
                  </Button>
                </TabsContent>
                <TabsContent value="signup" className="flex flex-col gap-5">
                  <Input
                    placeholder="Email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="rounded-full"
                    required
                  />
                  <Input
                    placeholder="Password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="rounded-full"
                    required
                  />
                  <Input
                    placeholder="Confirm Password"
                    type="password"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSignup(e);
                    }}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="rounded-full"
                    required
                  />
                  <Button
                    className="rounded-full p-6 w-full"
                    onClick={handleSignup}
                  >
                    Signup
                  </Button>
                </TabsContent>
              </Tabs>
            </div>
          </div>
          <div className="hidden xl:flex justify-center items-center">
            <img src={Background} alt="background login" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;
