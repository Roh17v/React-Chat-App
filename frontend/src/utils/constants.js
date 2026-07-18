export const HOST = import.meta.env.VITE_BASE_URL;

export const AUTH_ROUTES = "/api/auth";

export const SIGNUP_ROUTE = `${AUTH_ROUTES}/signup`;

export const LOGIN_ROUTE = `${AUTH_ROUTES}/login`;

export const VERIFY_EMAIL_ROUTE = `${AUTH_ROUTES}/verify-email`;

export const RESEND_OTP_ROUTE = `${AUTH_ROUTES}/resend-otp`;

export const FORGOT_PASSWORD_ROUTE = `${AUTH_ROUTES}/forgot-password`;

export const RESET_PASSWORD_ROUTE = `${AUTH_ROUTES}/reset-password`;

export const USER_ROUTES = "/api/users";

export const LOGOUT_ROUTE = `${AUTH_ROUTES}/logout`;

export const MESSAGES_ROUTE = "/api/messages";

export const PRIVATE_CONTACT_MESSAGES_ROUTE = `${MESSAGES_ROUTE}/private`;

export const CHANNEL_MESSAGES_ROUTE = `${MESSAGES_ROUTE}/channel`;

// Unified incremental sync feed — fetches all new messages across all
// conversations in a single round trip (replaces N per-conversation calls).
export const SYNC_UPDATES_ROUTE = `${MESSAGES_ROUTE}/updates`;

export const DM_CONTACTS_ROUTE = `${USER_ROUTES}/dm-contacts`;
export const USER_UPDATES_ROUTE = `${USER_ROUTES}/updates`;

export const REGISTER_PUSH_TOKEN_ROUTE = `${HOST}${USER_ROUTES}/push-token`;

export const UPLOAD_FILE_ROUTE = `${HOST}${MESSAGES_ROUTE}/upload-file`;

export const GET_ALL_CONTACTS_ROUTE = `${HOST}${USER_ROUTES}/contacts`;

export const CHANNEL_ROUTE = `/api/channels`;

export const CREATE_NEW_CHANNEL_ROUTE = `${HOST}${CHANNEL_ROUTE}`;

export const GET_USER_CHANNELS_ROUTE = `${HOST}${CHANNEL_ROUTE}`;

export const TURN_CREDENTIALS_ROUTE = `/api/turn`;

export const GET_TURN_CREDENTIALS = `${HOST}${TURN_CREDENTIALS_ROUTE}/credentials`;

export const CALL_ROUTE = `/api/calls`;

export const CALL_FINALIZE_ROUTE = `${HOST}${CALL_ROUTE}/finalize`;

export const DELETE_FOR_ME_ROUTE = `${MESSAGES_ROUTE}`;
export const DELETE_FOR_EVERYONE_ROUTE = `${MESSAGES_ROUTE}`;

// Durable mark-read REST endpoint — pairs with the `confirm-read` socket
// event so unread state is consistent even when the socket is mid-reconnect
// or the app is backgrounded right after the user opens a chat.
export const MARK_READ_ROUTE = `${MESSAGES_ROUTE}/mark-read`;
