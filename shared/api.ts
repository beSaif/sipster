// API contract shared by the Worker and the app. docs/SOCIAL.md describes every endpoint.
// Everything here is JSON over same-origin fetch with the session cookie; nothing needs a token.

export type ErrorCode = 'unauthorized' | 'validation' | 'not_found' | 'conflict' | 'rate_limited' | 'forbidden' | 'internal';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

// ---- account --------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  /** Chosen after the first sign-in; null until then. The app shows the username picker while it is null. */
  username: string | null;
  /** Push notifications for friend requests, acceptances and friends reaching their goal. */
  social_push: boolean;
  created_at: number;
}

/** GET /api/auth/me */
export interface Me {
  user: User;
  /** Unread in-app notifications, for the badge on the home screen. */
  unread: number;
}

/** Why a Google sign-in came back to `#/account` without a session (the `error` hash parameter). */
export type SignInError = 'cancelled' | 'failed' | 'signups_disabled';

/** POST /api/auth/claim: the one-time code from the `claim` hash parameter after a sign-in. */
export interface ClaimInput {
  code: string;
}

/** PUT /api/auth/username */
export interface UsernameInput {
  username: string;
}

/** GET /api/auth/username/check?username=… */
export interface UsernameCheck {
  valid: boolean;
  /** False when another account has it (case-insensitively). Always true for the caller's own name. */
  available: boolean;
}

/** PUT /api/auth/settings */
export interface AccountSettingsInput {
  social_push?: boolean;
}

/** POST /api/auth/logout: the device's push endpoint, so the server stops sending it social pushes. */
export interface LogoutInput {
  endpoint?: string;
}

/** DELETE /api/auth/account: the account's email, typed again as confirmation. */
export interface DeleteAccountInput {
  email: string;
}

// ---- friends ----------------------------------------------------------------

export interface Person {
  id: string;
  username: string;
}

export interface FriendRequest extends Person {
  /** When the request was made. */
  since: number;
}

/** GET /api/friends */
export interface FriendsResponse {
  friends: Person[];
  /** Requests waiting for the caller's answer. */
  incoming: FriendRequest[];
  /** Requests the caller sent that are still pending. */
  outgoing: FriendRequest[];
}

/** POST /api/friends/request */
export interface FriendRequestInput {
  username: string;
}
export type FriendRequestOutcome = 'pending' | 'accepted' | 'already_friends' | 'already_pending';
export interface FriendRequestResponse {
  status: FriendRequestOutcome;
  user: Person;
}

/** POST /api/friends/accept, POST /api/friends/decline */
export interface FriendAnswerInput {
  user_id: string;
}

// ---- totals & leaderboard ---------------------------------------------------

export interface DayTotal {
  /** The user's local date, 'YYYY-MM-DD'. */
  day: string;
  ml: number;
  goal_ml: number;
}

/** PUT /api/totals: today, and on first sign-in the last 30 days. */
export interface TotalsInput {
  days: DayTotal[];
}

export interface LeaderboardEntry {
  id: string;
  username: string;
  ml: number;
  goal_ml: number;
  /** Whole percent of the goal (today) or the average daily percent (week). Not capped. */
  pct: number;
  is_me: boolean;
  /** 1-based position. */
  rank: number;
}

export interface WeekEntry extends LeaderboardEntry {
  /** Days of the seven on which the goal was reached. */
  days_hit: number;
}

/** GET /api/leaderboard?day=YYYY-MM-DD (the caller's local date). You and your accepted friends. */
export interface Leaderboard {
  day: string;
  today: LeaderboardEntry[];
  /** The seven days ending on `day`. */
  week: WeekEntry[];
}

// ---- notifications ----------------------------------------------------------

export type NotificationKind = 'friend_request' | 'friend_accepted' | 'goal_reached';

export interface Notification {
  id: string;
  kind: NotificationKind;
  /** Who caused it; null once that account is gone. */
  actor: Person | null;
  /** goal_reached: the day. */
  ref: string | null;
  created_at: number;
  read_at: number | null;
}

/** GET /api/notifications (newest first, at most 50) */
export interface NotificationsResponse {
  unread: number;
  items: Notification[];
}

/** POST /api/notifications/read marks everything read and answers this. */
export interface ReadResponse {
  unread: 0;
}

// ---- push payloads ----------------------------------------------------------

/** What the Worker encrypts into a push. The service worker switches on `type`. */
export interface NudgePush {
  type: 'nudge' | 'test';
  title: string;
  body: string;
}

export interface SocialPush {
  type: 'social';
  kind: NotificationKind;
  title: string;
  body: string;
  /** Where a tap takes you, e.g. '/#/inbox'. */
  url: string;
}

export type PushPayload = NudgePush | SocialPush;
