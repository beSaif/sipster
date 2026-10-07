// Privacy policy: public, linked from the account screen, Settings and Google's consent screen.
// Plain words: what Sipster stores, where, who can see it and how to get rid of it (docs/SOCIAL.md §7).
// Anyone can land here, before the intro and without an account, so it depends on neither.

import { account } from '../account';
import { ICONS, el } from '../dom';
import { back } from '../router';

const REPO = 'https://github.com/beSaif/sipster';

export function mountPrivacy(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen privacy">
      <header class="topbar start">
        <button class="icon-btn" type="button" aria-label="Back" data-back>${ICONS.back}</button>
        <span class="kicker">Sipster</span>
      </header>
      <h1 class="title">Privacy policy</h1>
      <p class="body">Gerald is a hamster, not a data broker. This is everything Sipster knows about you, where it lives and who can see it.</p>
      <p class="help">Last updated 6 October 2026.</p>

      <section class="card">
        <h2>What stays on your phone</h2>
        <p class="body small">Every drink you log and every setting — goal, cup sizes, reminder hours — lives in your browser’s own database (IndexedDB) on this phone. Nothing leaves it unless you export a backup. Clearing the browser’s site data clears it too, so export first.</p>
      </section>

      <section class="card">
        <h2>The reminder server</h2>
        <p class="body small">Nudges need a small server (a Cloudflare Worker) to send them while the app is closed. When you turn them on, it stores this phone’s push address, your reminder schedule and time zone, when you last drank and whether today’s goal is done — enough to know when to nudge and when to keep quiet. Without an account it is never told how much you drink. Turn nudges off and it forgets the phone.</p>
      </section>

      <section class="card">
        <h2>With an account</h2>
        <p class="body small">Signing in with Google is optional. Google tells Gerald your Google account id and your email address, nothing else: no name, no photo, no contacts, no calendar. The server then stores:</p>
        <ul>
          <li>that Google id and email, to recognise you next time;</li>
          <li>your username;</li>
          <li>your daily totals — millilitres and goal per day — so friends can compare. The drinks themselves stay on your phone;</li>
          <li>your friends and friend requests;</li>
          <li>your notifications (requests, acceptances, friends reaching their goal), kept for 60 days.</li>
        </ul>
        <p class="body small">Accepted friends see your username and your daily totals. Nobody is ever shown your email. Nothing is public: the only way to find you is to type your exact username.</p>
      </section>

      <section class="card">
        <h2>Cookies</h2>
        <p class="body small">After you sign in, one session cookie keeps you signed in for up to 30 days. While you are signing in, a second cookie lives for ten minutes to check that the answer really came from Google. That is all: no analytics, no trackers, no third-party cookies.</p>
      </section>

      <section class="card">
        <h2>Notifications</h2>
        <p class="body small">Every push — a nudge or friend news — is encrypted for your phone before it is handed to your browser’s push service (Apple, Google or Mozilla), which only sees scrambled bytes. The server keeps nothing but the push address it needs to send them. Friend notifications can be switched off in Settings.</p>
      </section>

      <section class="card">
        <h2>Your rights</h2>
        <p class="body small">Your data is yours. Export or import a backup from Settings at any time. Delete your account from the account screen: that removes your account, username, totals, friendships and notifications from the server at once. Nudges keep working and your drinks stay on the phone. Questions or worries? Open an issue on <a href="${REPO}/issues" target="_blank" rel="noopener">the repository</a>.</p>
      </section>

      <p class="help">Sipster is open source: <a href="${REPO}" target="_blank" rel="noopener">github.com/beSaif/sipster</a></p>
      <button class="btn primary" type="button" data-back>Got it</button>
    </main>`);
  root.replaceChildren(view);
  // With no history to go back to (Google's consent screen links straight here), signed-out people land on the sign-in screen.
  const leave = () => back(account().status === 'out' ? '#/account' : '#/');
  view.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', leave));
  return () => {};
}
