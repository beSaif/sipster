// Gerald's lines. Kept in one place so the app and the push worker sound the same.

export interface Nudge {
  title: string;
  body: string;
}

export const NUDGES_THIRSTY: Nudge[] = [
  { title: 'Gerald is staring at you.', body: 'He stared at the empty bottle. Then at you. Then at the bottle.' },
  { title: 'Psst. Water. You. Now.', body: 'Gerald says please. Gerald rarely says please.' },
  { title: 'Hydration check!', body: 'Gerald’s cheeks are deflating. Have a glass, he gets a sip.' },
  { title: 'Gerald has entered his dramatic phase.', body: 'He is lying face-down in the wood shavings. A glass would fix this.' },
  { title: 'Water o’clock.', body: 'Gerald has been tapping his tiny wrist. He doesn’t own a watch.' },
];

export const NUDGES_PARCHED: Nudge[] = [
  { title: 'Gerald has started licking the glass.', body: 'This is a cry for help.' },
  { title: 'Gerald is now 40% dust.', body: 'It has been a while. One glass brings him back.' },
  { title: 'A tumbleweed just rolled past Gerald.', body: 'He named it Steve. Please drink something.' },
];

export function pickNudge(hoursSinceSip: number | null, seed: number): Nudge {
  const bank = hoursSinceSip !== null && hoursSinceSip >= 3 ? NUDGES_PARCHED : NUDGES_THIRSTY;
  return bank[Math.abs(Math.floor(seed)) % bank.length];
}

export const TEST_NUDGE: Nudge = {
  title: 'Testing, testing… *tap tap*',
  body: 'Gerald can reach you. Nudges are working.',
};

// --- Friends ----------------------------------------------------------------

export type SocialKind = 'friend_request' | 'friend_accepted' | 'goal_reached';

/** Title and body for a social notification about `@username`. Used for in-app items and pushes alike. */
export function socialCopy(kind: SocialKind, username: string): Nudge {
  const who = `@${username}`;
  switch (kind) {
    case 'friend_request':
      return { title: `${who} wants to be cage-mates.`, body: 'Accept, and you can see who drinks more. Gerald is already judging.' };
    case 'friend_accepted':
      return { title: `${who} accepted your request.`, body: 'You’re cage-mates now. May the most hydrated hamster win.' };
    case 'goal_reached':
      return { title: `${who} hit their water goal.`, body: 'Their hamster is a moist little king. Yours is watching.' };
  }
}
