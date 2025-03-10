export const HOST = import.meta.env.VITE_BASE_URL;

export const AUTH_ROUTES = "/api/auth";

export const SIGNUP_ROUTE = `${AUTH_ROUTES}/signup`;

export const LOGIN_ROUTE = `${AUTH_ROUTES}/login`;

export const USER_ROUTES = "/api/users";

export const LOGOUT_ROUTE = `${AUTH_ROUTES}/logout`;

export const MESSAGES_ROUTE = "/api/messages";

export const DM_CONTACTS_ROUTE = `${USER_ROUTES}/dm-contacts`;

export const UPLOAD_FILE_ROUTE = `${HOST}${MESSAGES_ROUTE}/upload-file`;
