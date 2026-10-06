// Leaderboard (today / this week) and friends: requests, add by username. docs/SOCIAL.md §6.
// TODO(agent D): implement.

import { el } from '../dom';

export function mountFriends(root: HTMLElement): () => void {
  root.replaceChildren(el('<main class="screen"><p class="body">Friends</p></main>'));
  return () => {};
}
