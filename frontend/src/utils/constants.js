export const HOST = import.meta.env.VITE_BASE_URL;

export const AUTH_ROUTES = "/api/auth";

export const SIGNUP_ROUTE = `${AUTH_ROUTES}/signup`;

export const LOGIN_ROUTE = `${AUTH_ROUTES}/login`;

export const USER_ROUTES = "/api/users";

export const LOGOUT_ROUTE = `${AUTH_ROUTES}/logout`;

export const MESSAGES_ROUTE = "/api/messages";

export const PRIVATE_CONTACT_MESSAGES_ROUTE = `${MESSAGES_ROUTE}/private`;

export const CHANNEL_MESSAGES_ROUTE = `${MESSAGES_ROUTE}/channel`;

export const DM_CONTACTS_ROUTE = `${USER_ROUTES}/dm-contacts`;

export const REGISTER_PUSH_TOKEN_ROUTE = `${HOST}${USER_ROUTES}/push-token`;

export const UPLOAD_FILE_ROUTE = `${HOST}${MESSAGES_ROUTE}/upload-file`;

export const GET_ALL_CONTACTS_ROUTE = `${HOST}${USER_ROUTES}/contacts`;

export const CHANNEL_ROUTE = `/api/channels`;

export const CREATE_NEW_CHANNEL_ROUTE = `${HOST}${CHANNEL_ROUTE}`;

export const GET_USER_CHANNELS_ROUTE = `${HOST}${CHANNEL_ROUTE}`;

export const TURN_CREDENTIALS_ROUTE = `/api/turn`;

export const GET_TURN_CREDENTIALS = `${HOST}${TURN_CREDENTIALS_ROUTE}/credentials`;

export const DELETE_FOR_ME_ROUTE = `${MESSAGES_ROUTE}`;
export const DELETE_FOR_EVERYONE_ROUTE = `${MESSAGES_ROUTE}`;
