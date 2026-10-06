// Privacy policy: public, linked from the account screen, Settings and Google's consent screen.
// TODO(agent C): implement.

import { el } from '../dom';

export function mountPrivacy(root: HTMLElement): () => void {
  root.replaceChildren(el('<main class="screen"><p class="body">Privacy</p></main>'));
  return () => {};
}
