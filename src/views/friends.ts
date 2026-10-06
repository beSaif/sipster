// Leaderboard (today / this week) and friends: requests, add by username. docs/SOCIAL.md §6.
// Everything here needs an account with a username; without one the screen is a pitch for #/account.

import type { FriendRequestOutcome, FriendsResponse, Leaderboard, LeaderboardEntry, Person, WeekEntry } from '../../shared/api';
import { USERNAME_MAX, usernameProblem } from '../../shared/username';
import { account, onAccount, refreshAccount, type AccountState } from '../account';
import { api, isApiError } from '../api';
import { ICONS, drawGeralds, el, esc, refs, toast } from '../dom';
import type { Hamster } from '../hamster';
import { haptic } from '../haptics';
import { localDate } from '../store';

type Tab = 'today' | 'week';
/** What the screen shows: a placeholder, a sign-in pitch, a username nudge, or the real thing. */
type Gate = 'loading' | 'out' | 'noname' | 'in';

const fmt = (n: number) => n.toLocaleString('en-US');
const BAR_SEGMENTS = 10;

const SENT: Record<FriendRequestOutcome, string> = {
  pending: 'Request sent. Gerald is crossing his paws.',
  accepted: 'You’re cage-mates now!',
  already_friends: 'Already cage-mates.',
  already_pending: 'Already asked. Patience.',
};
const OFFLINE = 'Couldn’t reach Gerald’s server. Are you online?';
const OOPS = 'Gerald tripped over something. Try again.';

function gateOf(s: AccountState): Gate {
  if (s.status !== 'in') return s.status;
  return s.user.username ? 'in' : 'noname';
}

/** Why accepting, declining or removing failed, in Gerald's words. */
function mutationError(err: unknown): string {
  if (!isApiError(err)) return OOPS;
  switch (err.code) {
    case 'offline':
      return OFFLINE;
    case 'not_found':
      return 'That request is gone already.';
    case 'forbidden':
      return 'Pick a username first.';
    case 'unauthorized':
      return 'You’re signed out. Sign in again.';
    default:
      return OOPS;
  }
}

/** Why a friend request failed. The name is checked here first, so a 400 from the server means "that's you". */
function requestError(err: unknown): string {
  if (!isApiError(err)) return OOPS;
  switch (err.code) {
    case 'not_found':
      return 'Nobody by that name. Check the spelling.';
    case 'validation':
      return 'That’s you. Gerald admires the confidence.';
    case 'rate_limited':
      return 'Too many open requests. Let a few answer first.';
    default:
      return mutationError(err);
  }
}

function gateMarkup(gate: Exclude<Gate, 'in'>): string {
  if (gate === 'loading') return '<section class="card"><p class="help">Checking who you are…</p></section>';
  if (gate === 'out') {
    return `
      <section class="card pitch">
        <span data-gerald="full" data-px="2" aria-hidden="true"></span>
        <h2>Sign in to compete.</h2>
        <p class="body">Add friends by username and see who keeps their hamster the wettest, today and this week. Only daily totals leave your phone, never single drinks.</p>
        <a class="btn primary" href="#/account">Sign in</a>
      </section>`;
  }
  return `
    <section class="card pitch">
      <span data-gerald="idle" data-px="2" aria-hidden="true"></span>
      <h2>Pick a username first.</h2>
      <p class="body">Friends find you by it, and a leaderboard needs names to shout.</p>
      <a class="btn primary" href="#/account">Choose a username</a>
    </section>`;
}

const MAIN = `
  <section class="card">
    <h2 id="board-title">Leaderboard</h2>
    <div class="segmented two" role="radiogroup" aria-labelledby="board-title">
      <button type="button" role="radio" aria-checked="true" data-tab="today">Today</button>
      <button type="button" role="radio" aria-checked="false" data-tab="week">This week</button>
    </div>
    <div data-ref="board"></div>
  </section>

  <section class="card">
    <h2>Add a friend</h2>
    <form class="add-friend" data-ref="form" novalidate>
      <label class="at-field">
        <span class="at" aria-hidden="true">@</span>
        <input data-ref="name" type="text" maxlength="${USERNAME_MAX}" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="username" aria-label="Their username">
      </label>
      <button class="btn" type="submit" data-ref="send">Send request</button>
    </form>
    <p class="help">Exact username, no search. Ask them for it.</p>
  </section>

  <section class="card" data-ref="incomingCard" hidden>
    <h2>Requests for you</h2>
    <ul class="rows" data-ref="incoming"></ul>
  </section>

  <section class="card" data-ref="outgoingCard" hidden>
    <h2>Waiting on an answer</h2>
    <ul class="rows" data-ref="outgoing"></ul>
  </section>

  <section class="card" data-ref="friendsCard" hidden>
    <h2>Cage-mates</h2>
    <ul class="rows" data-ref="friends"></ul>
  </section>`;

export function mountFriends(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen friends">
      <header class="topbar start">
        <a class="icon-btn" href="#/" aria-label="Back to today">${ICONS.back}</a>
        <h1 class="logo">Friends</h1>
      </header>
      <div class="social-list" data-ref="content"></div>
    </main>`);
  const r = refs(view);
  root.replaceChildren(view);

  let gate: Gate | null = null;
  // Refs inside MAIN; null while a gate card is showing.
  let m: Record<string, HTMLElement> | null = null;
  let sprites: Hamster[] = [];
  let tab: Tab = 'today';
  let board: Leaderboard | null = null;
  let friends: FriendsResponse | null = null;
  let loading = false;
  let netError = false;
  let busy = false;
  let loadSeq = 0;

  function rowMarkup(e: LeaderboardEntry, daysHit: number | null, contest: boolean): string {
    const pct = Math.max(0, Math.round(e.pct));
    const filled = Math.round((Math.min(pct, 100) / 100) * BAR_SEGMENTS);
    const segs = Array.from({ length: BAR_SEGMENTS }, (_, i) => `<i class="${i < filled ? (pct > 100 ? 'over' : 'on') : ''}"></i>`).join('');
    // The crown goes to first place, but not for being alone or for drinking nothing.
    const leader = contest && e.rank === 1 && e.ml > 0;
    return `
      <li class="board-row${e.is_me ? ' me' : ''}${leader ? ' leader' : ''}${daysHit === null ? '' : ' week'}">
        <span class="rank" aria-label="Rank ${e.rank}${leader ? ', in the lead' : ''}">${e.rank}</span>
        <span class="who"><span class="name">@${esc(e.username)}</span>${e.is_me ? '<span class="chip you">you</span>' : ''}</span>
        <span class="ml"><b>${fmt(e.ml)}</b> / ${fmt(e.goal_ml)} ml</span>
        <span class="bar" role="img" aria-label="${pct}% of goal">${segs}</span>
        <span class="pct">${pct}%</span>
        ${daysHit === null ? '' : `<span class="hits">goal hit ${daysHit}/7</span>`}
      </li>`;
  }

  function boardMarkup(): string {
    const error = netError
      ? '<div class="note row">Couldn’t reach Gerald’s server.<button class="link-btn" type="button" data-act="retry">Retry</button></div>'
      : '';
    if (!board) return error || (loading ? '<p class="help">Fetching the standings…</p>' : '');
    const entries: LeaderboardEntry[] = tab === 'today' ? board.today : board.week;
    const contest = entries.length > 1;
    const rows = entries.map((e) => rowMarkup(e, tab === 'week' ? (e as WeekEntry).days_hit : null, contest)).join('');
    const alone = contest ? '' : '<p class="help">Just you and Gerald so far. Add a friend below.</p>';
    return `${error}<ol class="board-rows">${rows}</ol>${alone}`;
  }

  function renderBoard(): void {
    if (m) m.board.innerHTML = boardMarkup();
  }

  function action(act: string, p: Person, label: string, cls = 'link-btn'): string {
    return `<button class="${cls}" type="button" data-act="${act}" data-id="${esc(p.id)}" data-name="${esc(p.username)}">${label}</button>`;
  }

  function renderLists(): void {
    if (!m) return;
    const f = friends ?? { friends: [], incoming: [], outgoing: [] };
    const fill = (card: HTMLElement, list: HTMLElement, people: Person[], actions: (p: Person) => string) => {
      card.hidden = people.length === 0;
      list.innerHTML = people
        .map((p) => `<li class="person-row"><span class="name">@${esc(p.username)}</span><span class="row-actions">${actions(p)}</span></li>`)
        .join('');
    };
    fill(m.incomingCard, m.incoming, f.incoming, (p) => action('accept', p, 'Accept', 'btn secondary') + action('decline', p, 'Decline'));
    fill(m.outgoingCard, m.outgoing, f.outgoing, (p) => action('cancel', p, 'Cancel'));
    fill(m.friendsCard, m.friends, f.friends, (p) => action('remove', p, 'Remove'));
    setBusy(busy);
  }

  /** Disables every button that talks to the server while one request is in flight. */
  function setBusy(on: boolean): void {
    busy = on;
    r.content.querySelectorAll<HTMLButtonElement>('button[data-act], button[type="submit"]').forEach((b) => (b.disabled = on));
  }

  async function load(): Promise<void> {
    if (!m) return;
    const seq = ++loadSeq;
    loading = true;
    renderBoard();
    const [b, f] = await Promise.allSettled([api.leaderboard(localDate()), api.friends()]);
    if (seq !== loadSeq || !m) return;
    loading = false;
    if (b.status === 'fulfilled') board = b.value;
    if (f.status === 'fulfilled') friends = f.value;
    const rejected = [b, f].filter((res): res is PromiseRejectedResult => res.status === 'rejected');
    // No username any more, or no session: the account state moves the gate; don't call it a network problem.
    const authLost = rejected.some((res) => isApiError(res.reason) && (res.reason.code === 'forbidden' || res.reason.code === 'unauthorized'));
    netError = rejected.length > 0 && !authLost;
    if (authLost) void refreshAccount();
    renderBoard();
    renderLists();
  }

  /** Runs one friends mutation, then refreshes the lists, the leaderboard and the badge. */
  async function mutate(call: () => Promise<unknown>, done: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await call();
      toast(done);
    } catch (err) {
      toast(mutationError(err));
    }
    await load();
    if (m) setBusy(false);
    void refreshAccount();
  }

  async function sendRequest(): Promise<void> {
    if (!m || busy) return;
    const input = m.name as HTMLInputElement;
    const username = input.value.trim().replace(/^@/, '');
    const problem = username ? usernameProblem(username) : 'Type a username first.';
    if (problem) {
      toast(problem);
      input.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await api.requestFriend({ username });
      toast(SENT[res.status] ?? 'Done.');
      input.value = '';
      await load();
      void refreshAccount();
    } catch (err) {
      toast(requestError(err));
    } finally {
      if (m) setBusy(false);
    }
  }

  function apply(s: AccountState): void {
    const next = gateOf(s);
    if (next === gate) return;
    gate = next;
    loadSeq++;
    sprites.forEach((h) => h.destroy());
    sprites = [];
    if (next !== 'in') {
      m = null;
      board = null;
      friends = null;
      netError = false;
      busy = false;
      r.content.innerHTML = gateMarkup(next);
      sprites = drawGeralds(r.content);
      return;
    }
    r.content.innerHTML = MAIN;
    m = refs(r.content);
    void load();
  }

  r.content.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tabBtn = target.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab === 'week' ? 'week' : 'today';
      r.content.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tab === tab)));
      renderBoard();
      return;
    }
    const btn = target.closest<HTMLButtonElement>('button[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.id ?? '';
    const name = btn.dataset.name ?? '';
    switch (btn.dataset.act) {
      case 'retry':
        return void load();
      case 'accept':
        return void mutate(() => api.acceptFriend({ user_id: id }), `You’re cage-mates with @${name} now!`);
      case 'decline':
        return void mutate(() => api.declineFriend({ user_id: id }), 'Declined. Gerald will let them down gently.');
      case 'cancel':
        return void mutate(() => api.removeFriend(id), 'Request withdrawn. Gerald saw nothing.');
      case 'remove':
        haptic('warning');
        if (!confirm(`Remove @${name} from your cage-mates? They won’t be told.`)) return;
        return void mutate(() => api.removeFriend(id), 'Removed. The cage feels roomier.');
    }
  });

  r.content.addEventListener('submit', (e) => {
    e.preventDefault();
    void sendRequest();
  });

  const onVisible = () => {
    if (document.visibilityState === 'visible' && m) void load();
  };
  document.addEventListener('visibilitychange', onVisible);

  apply(account());
  const offAccount = onAccount(apply);

  return () => {
    offAccount();
    document.removeEventListener('visibilitychange', onVisible);
    sprites.forEach((h) => h.destroy());
    m = null;
    loadSeq++;
  };
}
