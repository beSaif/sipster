/** Bindings, vars and secrets available to the Worker (see wrangler.jsonc, .dev.vars.example, docs/SOCIAL.md §8). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** Optional "mailto:" / "https:" contact; defaults to the app's own origin. */
  VAPID_SUBJECT?: string;
  /** "true" lets any http(s) endpoint subscribe (local testing only). */
  ALLOW_ANY_PUSH_HOST?: string;
  /** The OAuth client from the Google Cloud console (type "Web application"). Sign-in is unavailable without both. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Google's endpoints; only tests override them, to point at a stand-in. */
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  /** "false" closes sign-ups: only Google accounts that already have a Sipster account get in. */
  SIGNUPS_ENABLED?: string;
}

/** The signed-in person, as `requireUser` puts it on the context. */
export interface SessionUser {
  id: string;
  email: string;
  username: string | null;
  social_push: boolean;
  created_at: number;
}

/** Hono generic: bindings + per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; sessionToken: string };
};
