// Username rules, checked the same way in the app (as you type) and on the server (before saving).

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
const USERNAME_RE = /^[A-Za-z0-9_]+$/;

/** Letters, digits and underscores, 3 to 20 of them. Case is kept but two names that differ only in case are the same name. */
export function isValidUsername(s: unknown): s is string {
  return typeof s === 'string' && s.length >= USERNAME_MIN && s.length <= USERNAME_MAX && USERNAME_RE.test(s);
}

/** Why a username is not valid, in Gerald's words, or null when it is fine. */
export function usernameProblem(s: string): string | null {
  if (s.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters. Gerald can’t pronounce shorter.`;
  if (s.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters. Gerald has a short memory.`;
  if (!USERNAME_RE.test(s)) return 'Letters, numbers and underscores only.';
  return null;
}
