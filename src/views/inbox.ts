// Notifications: friend requests, acceptances, friends reaching their goal. docs/SOCIAL.md §6.
// TODO(agent D): implement.

import { el } from '../dom';

export function mountInbox(root: HTMLElement): () => void {
  root.replaceChildren(el('<main class="screen"><p class="body">Inbox</p></main>'));
  return () => {};
}
