// Sign in with Google, pick a username, manage the account. docs/SOCIAL.md §5 and §6.
// TODO(agent C): implement.

import { el } from '../dom';

export function mountAccount(root: HTMLElement): () => void {
  root.replaceChildren(el('<main class="screen"><p class="body">Account</p></main>'));
  return () => {};
}
