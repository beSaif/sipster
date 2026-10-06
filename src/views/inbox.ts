// Notifications: friend requests, acceptances, friends reaching their goal. docs/SOCIAL.md §6.
// Opening the inbox marks everything read on the server; what was unread when you arrived stays
// highlighted until you leave, so you can tell what's new.

import type { Notification } from '../../shared/api';
import { socialCopy } from '../../shared/copy';
import { account, onAccount, refreshAccount, setUnread, type AccountState } from '../account';
import { api, isApiError } from '../api';
import { ICONS, el, esc, refs, toast } from '../dom';

type Gate = 'loading' | 'out' | 'in';

const OOPS = 'Gerald tripped over something. Try again.';
const ERROR_NOTE = '<div class="note row">Couldn’t reach Gerald’s server.<button class="link-btn" type="button" data-act="retry">Retry</button></div>';
const EMPTY_CARD = `<section class="card empty">${ICONS.inbox}<p class="body">Nothing yet. Gerald is listening for the doorbell.</p></section>`;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a short date. */
function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 2) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function answerError(err: unknown): string {
  if (!isApiError(err)) return OOPS;
  switch (err.code) {
    case 'offline':
      return 'Couldn’t reach Gerald’s server. Are you online?';
    case 'not_found':
      return 'That request is gone already.';
    case 'forbidden':
      return 'Pick a username first.';
    default:
      return OOPS;
  }
}

export function mountInbox(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen inbox">
      <header class="topbar start">
        <a class="icon-btn" href="#/" aria-label="Back to today">${ICONS.back}</a>
        <h1 class="logo">Inbox</h1>
      </header>
      <div class="social-list" data-ref="content"></div>
    </main>`);
  const r = refs(view);
  root.replaceChildren(view);

  let gate: Gate | null = null;
  let items: Notification[] | null = null;
  // Who has a pending request to me: their friend_request items get Accept / Decline buttons.
  let incoming = new Set<string>();
  // Unread when the screen opened (or arrived since): highlighted even once marked read.
  const fresh = new Set<string>();
  let netError = false;
  let busy = false;
  let seq = 0;

  function itemMarkup(n: Notification): string {
    const { title, body } = socialCopy(n.kind, n.actor?.username ?? 'someone');
    let actions = '';
    if (n.kind === 'friend_request' && n.actor && incoming.has(n.actor.id)) {
      const data = `data-id="${esc(n.actor.id)}" data-name="${esc(n.actor.username)}"`;
      actions = `<div class="inbox-actions"><button class="btn secondary" type="button" data-act="accept" ${data}>Accept</button><button class="link-btn" type="button" data-act="decline" ${data}>Decline</button></div>`;
    } else if (n.kind === 'goal_reached') {
      actions = '<div class="inbox-actions"><a class="link-btn" href="#/friends">See the leaderboard</a></div>';
    }
    const when = Number.isFinite(n.created_at) ? n.created_at : Date.now();
    return `
      <li class="inbox-item${fresh.has(n.id) ? ' unread' : ''}">
        <div class="inbox-head">
          <p class="inbox-title">${esc(title)}</p>
          <time class="inbox-time" datetime="${new Date(when).toISOString()}">${esc(ago(when))}</time>
        </div>
        <p class="inbox-body">${esc(body)}</p>
        ${actions}
      </li>`;
  }

  function render(): void {
    if (gate !== 'in') return;
    const error = netError ? ERROR_NOTE : '';
    if (!items) {
      r.content.innerHTML = error || '<section class="card"><p class="help">Checking the doormat…</p></section>';
      return;
    }
    r.content.innerHTML = error + (items.length ? `<ol class="inbox-list">${items.map(itemMarkup).join('')}</ol>` : EMPTY_CARD);
    setBusy(busy);
  }

  function setBusy(on: boolean): void {
    busy = on;
    r.content.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => (b.disabled = on));
  }

  async function markRead(): Promise<void> {
    try {
      await api.markNotificationsRead();
      setUnread(0);
    } catch {
      // The badge catches up the next time the account refreshes.
    }
  }

  async function load(): Promise<void> {
    const s = account();
    if (s.status !== 'in') return;
    const my = ++seq;
    if (!items) render();
    // The friends list is only for the inline Accept / Decline buttons, and it needs a username.
    const [notes, friends] = await Promise.allSettled([api.notifications(), s.user.username ? api.friends() : Promise.resolve(null)]);
    if (my !== seq) return;
    netError = notes.status === 'rejected';
    if (notes.status === 'fulfilled') {
      items = [...notes.value.items].sort((a, b) => b.created_at - a.created_at);
      for (const n of items) if (!n.read_at) fresh.add(n.id);
    }
    if (friends.status === 'fulfilled' && friends.value) incoming = new Set(friends.value.incoming.map((p) => p.id));
    render();
    if (notes.status === 'fulfilled' && notes.value.unread > 0) await markRead();
  }

  /** Accepts or declines from the inbox, then re-reads everything so the buttons and the badge follow. */
  async function answer(call: () => Promise<void>, done: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await call();
      toast(done);
    } catch (err) {
      toast(answerError(err));
    }
    busy = false;
    await load();
    void refreshAccount();
  }

  r.content.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.id ?? '';
    const name = btn.dataset.name ?? '';
    switch (btn.dataset.act) {
      case 'retry':
        return void load();
      case 'accept':
        return void answer(() => api.acceptFriend({ user_id: id }), `You’re cage-mates with @${name} now!`);
      case 'decline':
        return void answer(() => api.declineFriend({ user_id: id }), 'Declined. Gerald will let them down gently.');
    }
  });

  function apply(s: AccountState): void {
    const next: Gate = s.status === 'in' ? 'in' : s.status;
    if (next === gate) return;
    gate = next;
    seq++;
    items = null;
    netError = false;
    busy = false;
    if (next === 'loading') {
      r.content.innerHTML = '<section class="card"><p class="help">Checking who you are…</p></section>';
    } else if (next === 'out') {
      r.content.innerHTML = `
        <section class="card pitch">
          <h2>Sign in to hear the doorbell.</h2>
          <p class="body">Friend requests, new cage-mates and friends hitting their goal land here. It takes an account.</p>
          <a class="btn primary" href="#/account">Sign in</a>
        </section>`;
    } else {
      void load();
    }
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible' && gate === 'in') void load();
  };
  document.addEventListener('visibilitychange', onVisible);

  apply(account());
  const offAccount = onAccount(apply);

  return () => {
    offAccount();
    document.removeEventListener('visibilitychange', onVisible);
    seq++;
  };
}
