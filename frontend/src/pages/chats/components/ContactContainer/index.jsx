import React, { useEffect } from "react";
import ProfileInfo from "./components/ProfileInfo";
import NewDm from "./components/NewDm/NewDm";
import useAppStore from "@/store";
import axios from "axios";
import {
  DM_CONTACTS_ROUTE,
  GET_USER_CHANNELS_ROUTE,
  HOST,
} from "@/utils/constants";
import ContactList from "@/components/ContactList.jsx";
import CreateChannel from "./components/CreateChannel";

const ContactContainer = () => {
  const {
    directMessagesContacts,
    setDirectMessagesContacts,
    channels,
    setChannels,
  } = useAppStore();

  useEffect(() => {
    const fetchDMContacts = async () => {
      try {
        const response = await axios.get(`${HOST}${DM_CONTACTS_ROUTE}`, {
          withCredentials: true,
        });

        setDirectMessagesContacts(response.data);
        setTimeout(() => {
          console.log(directMessagesContacts);
        }, 2000);
      } catch (error) {
        console.log(error);
      }
    };

    const userChannels = async () => {
      try {
        const response = await axios.get(GET_USER_CHANNELS_ROUTE, {
          withCredentials: true,
        });

        if (response.status === 200) {
          setChannels(response.data);
          console.log(channels);
        }
      } catch (error) {
        console.log(error);
      }
    };

    userChannels();

    fetchDMContacts();
  }, [setChannels, setDirectMessagesContacts]);

  return (
    <div className="relative md:w-[35vw] lg:w-[30vw] xl:w-[20vw] bg-[#1b1c24] border-r-2 border-[#2f303b] w-full">
      <div className="pt-3">
        <Logo />
      </div>
      <div className="my-5">
        <div className="flex items-center justify-between pr-10">
          <Title text="Direct Messages" />
          <NewDm />
        </div>
        <div className="max-h-[30vh] overflow-y-auto scrollbar-hidden px-5">
          <ContactList contacts={directMessagesContacts} />
        </div>
      </div>
      <div className="my-5">
        <div className="flex items-center justify-between pr-10">
          <Title text="Channels" />
          <CreateChannel />
        </div>
        <div className="max-h-[30vh] overflow-y-auto scrollbar-hidden px-5">
          <ContactList contacts={channels} isChannel />
        </div>
      </div>
      <ProfileInfo />
    </div>
  );
};

export default ContactContainer;

const Logo = () => {
  return (
    <div className="flex p-5  justify-start items-center gap-2">
      <svg
        id="logo-38"
        width="78"
        height="32"
        viewBox="0 0 78 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {" "}
        <path
          d="M55.5 0H77.5L58.5 32H36.5L55.5 0Z"
          className="ccustom"
          fill="#8338ec"
        ></path>{" "}
        <path
          d="M35.5 0H51.5L32.5 32H16.5L35.5 0Z"
          className="ccompli1"
          fill="#975aed"
        ></path>{" "}
        <path
          d="M19.5 0H31.5L12.5 32H0.5L19.5 0Z"
          className="ccompli2"
          fill="#a16ee8"
        ></path>{" "}
      </svg>
      <span className="text-3xl font-semibold ">Syncronus</span>
    </div>
  );
};

const Title = ({ text }) => {
  return (
    <div className="uppercase tracking-widest text-neutral-400 pl-10 font-light text-opacity-90 text-sm">
      {text}
    </div>
  );
};
