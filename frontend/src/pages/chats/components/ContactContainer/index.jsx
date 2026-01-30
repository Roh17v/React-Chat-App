import React, { useEffect } from "react";
import useAppStore from "@/store";
import axios from "axios";
import {
  DM_CONTACTS_ROUTE,
  GET_USER_CHANNELS_ROUTE,
  HOST,
} from "@/utils/constants";
import ContactList from "@/components/ContactList.jsx";
import ProfileInfo from "./components/ProfileInfo";
import NewDm from "./components/NewDm/NewDm";
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
        }
      } catch (error) {
        console.log(error);
      }
    };

    userChannels();
    fetchDMContacts();
  }, [setChannels, setDirectMessagesContacts]);

  return (
    <div className="relative w-full md:w-[320px] lg:w-[360px] h-full bg-sidebar border-r border-sidebar-border flex flex-col safe-area-top">
      {/* Header with Logo */}
      <div className="h-16 sm:h-[72px] flex items-center justify-between px-4 border-b border-sidebar-border bg-background-secondary/50">
        <h1 className="text-xl font-bold text-foreground tracking-tight">
          Messages
        </h1>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Direct Messages Section */}
        <div className="py-3">
          <div className="flex items-center justify-between px-4 mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
              Direct Messages
            </h2>
            <NewDm />
          </div>
          <div className="px-2">
            <ContactList contacts={directMessagesContacts} />
          </div>
        </div>

        {/* Divider */}
        <div className="mx-4 border-t border-sidebar-border" />

        {/* Channels Section */}
        <div className="py-3">
          <div className="flex items-center justify-between px-4 mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
              Channels
            </h2>
            <CreateChannel />
          </div>
          <div className="px-2">
            <ContactList contacts={channels} isChannel={true} />
          </div>
        </div>
      </div>

      {/* Profile Section - Fixed at bottom */}
      <div className="border-t border-sidebar-border bg-background-secondary/30">
        <ProfileInfo />
      </div>
    </div>
  );
};

export default ContactContainer;