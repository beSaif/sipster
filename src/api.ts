// Typed client for the Worker's account API (docs/SOCIAL.md §4). Same-origin JSON with the session
// cookie. Errors become `ApiError` with the server's code; a network failure is the `offline` code.
// Signing in is not a call: the browser leaves for `/api/auth/google/start` and comes back.
// DOM-free on purpose: the service worker uses it too (daily totals after a notification action).

import type {
  AccountSettingsInput,
  ApiErrorBody,
  ClaimInput,
  DeleteAccountInput,
  ErrorCode,
  FriendAnswerInput,
  FriendRequestInput,
  FriendRequestResponse,
  FriendsResponse,
  Leaderboard,
  LogoutInput,
  Me,
  NotificationsResponse,
  ReadResponse,
  TotalsInput,
  User,
  UsernameCheck,
  UsernameInput,
} from '../shared/api';

export type ApiErrorCode = ErrorCode | 'offline' | 'http';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  constructor(code: ApiErrorCode, status: number, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

const KNOWN: ReadonlySet<string> = new Set<ErrorCode>(['unauthorized', 'validation', 'not_found', 'conflict', 'rate_limited', 'forbidden', 'internal']);

let onUnauthorized: (() => void) | null = null;

/** The app registers what a lost session does (forget the cached account). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  /** Don't run the logged-out handler on 401 (probing the session). */
  quiet401?: boolean;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('offline', 0, 'Network request failed');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    const code: ApiErrorCode =
      err && KNOWN.has(err.code) ? err.code : res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : res.status >= 500 ? 'internal' : 'http';
    if (code === 'unauthorized' && !opts.quiet401) onUnauthorized?.();
    throw new ApiError(code, res.status, typeof err?.message === 'string' ? err.message : `HTTP ${res.status}`);
  }
  return data as T;
}

const q = (params: Record<string, string>): string => `?${new URLSearchParams(params).toString()}`;

export const api = {
  // ---- account ----
  /** A full-page navigation (not a fetch): the Worker sends the browser on to Google and back. */
  googleSignInUrl: '/api/auth/google/start',
  me: (opts?: RequestOptions) => request<Me>('GET', '/auth/me', undefined, opts),
  claim: (body: ClaimInput) => request<Me>('POST', '/auth/claim', body, { quiet401: true }),
  logout: (body: LogoutInput = {}) => request<void>('POST', '/auth/logout', body, { quiet401: true }),
  deleteAccount: (body: DeleteAccountInput) => request<void>('DELETE', '/auth/account', body),
  setUsername: (body: UsernameInput) => request<{ user: User }>('PUT', '/auth/username', body),
  checkUsername: (username: string) => request<UsernameCheck>('GET', `/auth/username/check${q({ username })}`),
  updateAccountSettings: (body: AccountSettingsInput) => request<{ user: User }>('PUT', '/auth/settings', body),

  // ---- friends ----
  friends: () => request<FriendsResponse>('GET', '/friends'),
  requestFriend: (body: FriendRequestInput) => request<FriendRequestResponse>('POST', '/friends/request', body),
  acceptFriend: (body: FriendAnswerInput) => request<void>('POST', '/friends/accept', body),
  declineFriend: (body: FriendAnswerInput) => request<void>('POST', '/friends/decline', body),
  removeFriend: (userId: string) => request<void>('DELETE', `/friends/${encodeURIComponent(userId)}`),

  // ---- totals & leaderboard ----
  putTotals: (body: TotalsInput) => request<void>('PUT', '/totals', body, { quiet401: true }),
  leaderboard: (day: string) => request<Leaderboard>('GET', `/leaderboard${q({ day })}`),

  // ---- notifications ----
  notifications: () => request<NotificationsResponse>('GET', '/notifications'),
  markNotificationsRead: () => request<ReadResponse>('POST', '/notifications/read', {}),
};
