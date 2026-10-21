/**
 * The terminal workspace: open terminals, tabs with one or two panes, the
 * favorites bar, aliases, tmux sessions found on hosts, the dock and the
 * switcher, attention and notifications, and the saved layout.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/TerminalProvider.tsx: live
 * cards, `place`, pins, restore, onBell / onAttention with the 30 s chime
 * cooldown), same owner, adapted to a desktop window with real tabs. State
 * that should survive a restart (favorites, aliases, layout, look) is saved
 * in the vault through `ui.save`; nothing is kept in renderer storage.
 */
import type { AdhocConnect, HostInfo, QuqaApi, UiState } from '../../../shared/ipc.js';
import type { TmuxSessionInfo } from '../../../shared/protocol.js';
import { call } from '../api.js';
import { playChime } from './chime.js';
import { HostProbe, SessionEvents, TerminalSession, type Look, type Target } from './connection.js';
import { buildRows, sortRows, type DockRow, type OpenTerminal } from './dockModel.js';
import { clampZoom } from './themes.js';

export type Split = 'none' | 'h' | 'v';

export interface Tab {
  id: string;
  /** Terminal tags; one or two. */
  panes: string[];
  split: Split;
  /** Index of the active pane. */
  active: number;
}

export interface Favorite {
  /** `<hostId>/<session>`, `host:<hostId>` or `tag:<tag>`. */
  key: string;
  hostId: string | null;
  session: string | null;
  tag: string | null;
  name: string;
  hostName: string;
  state: DockRow['state'] | 'host';
  busy: boolean;
  attention: boolean;
}

export interface FoundSessions {
  available: boolean;
  sessions: TmuxSessionInfo[];
  at: number;
}

export const DEFAULT_UI: UiState = {
  scheme: 'default',
  font: 'system',
  zoom: 0,
  notifications: true,
  sound: false,
  restoreTabs: true,
  groupDock: true,
  favorites: [],
  aliases: [],
  forgotten: [],
  layout: { tabs: [], active: -1 },
};

export const MAX_FAVORITES_SHOWN = 8;
export const MAX_ALIAS_LENGTH = 60;
const CHIME_COOLDOWN_MS = 30_000;
const BELL_GAP_MS = 3000;
const SAVE_DELAY_MS = 400;

let nextTab = 0;

export function newTmuxName(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `quqa-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class Workspace {
  hosts: HostInfo[] = [];
  ui: UiState = DEFAULT_UI;
  readonly terms = new Map<string, TerminalSession>();
  tabs: Tab[] = [];
  /** null: the Hosts screen. */
  activeTab: string | null = null;
  readonly found = new Map<string, FoundSessions>();
  switcherOpen = false;
  dockOpen = false;
  /** One-shot logins listing or ending tmux sessions; several may run at once. */
  probes: HostProbe[] = [];
  /** Pinned plain shells (not saved: they do not survive a restart). */
  private readonly pinnedTags = new Set<string>();
  /** Names of plain shells (not saved). */
  private readonly tagAliases = new Map<string, string>();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private restored = false;
  /** Nothing is saved before the vault's UI state was read (it would be overwritten). */
  private loaded = false;
  private chimeAt = 0;
  private rangAt = 0;
  private rowsCache: { version: number; rows: DockRow[] } | null = null;

  constructor(
    private readonly api: QuqaApi,
    private readonly events: SessionEvents,
  ) {
    api.onNotificationClick((tag) => {
      if (this.terms.has(tag)) this.focusTerm(tag);
    });
  }

  /* ----- Observing --------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /* ----- Loading ----------------------------------------------------------- */

  /** Hosts and UI state from the vault; re-opens the saved layout once per run. */
  load(hosts: HostInfo[], ui: UiState): void {
    this.hosts = hosts;
    this.ui = ui;
    this.loaded = true;
    this.applyLook();
    this.changed();
    if (!this.restored) {
      this.restored = true;
      if (ui.restoreTabs) this.restoreLayout();
    }
  }

  setHosts(hosts: HostInfo[]): void {
    this.hosts = hosts;
    this.applyLook();
    this.changed();
  }

  host(hostId: string | null): HostInfo | undefined {
    return hostId === null ? undefined : this.hosts.find((h) => h.id === hostId);
  }

  private restoreLayout() {
    for (const saved of this.ui.layout.tabs) {
      const tags: string[] = [];
      for (const pane of saved.panes) {
        if (!this.host(pane.hostId)) continue;
        const session = this.createTerminal(
          { kind: 'host', hostId: pane.hostId, title: '' },
          pane.session,
        );
        session.wasRestored = true;
        tags.push(session.tag);
      }
      if (tags.length === 0) continue;
      this.tabs.push({
        id: `tab${++nextTab}`,
        panes: tags,
        split: tags.length === 2 ? (saved.split === 'none' ? 'h' : saved.split) : 'none',
        active: 0,
      });
    }
    const active = this.tabs[this.ui.layout.active];
    this.activeTab = active?.id ?? null;
    this.layoutChanged(false);
  }

  /* ----- UI state ---------------------------------------------------------- */

  updateUi(change: Partial<UiState>): void {
    this.ui = { ...this.ui, ...change };
    if ('scheme' in change || 'font' in change || 'zoom' in change) this.applyLook();
    this.changed();
    this.scheduleSave();
  }

  private scheduleSave() {
    if (!this.loaded) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void call('ui.save', this.ui).catch(() => undefined);
    }, SAVE_DELAY_MS);
  }

  /** The look for a host: its own scheme/font, or the app's. */
  lookFor(hostId: string | null): Look {
    const host = this.host(hostId);
    return {
      scheme: host?.scheme || this.ui.scheme,
      font: host?.font || this.ui.font,
      zoom: this.ui.zoom,
    };
  }

  private applyLook() {
    for (const session of this.terms.values()) session.setLook(this.lookFor(session.hostId));
  }

  zoom(step: number | 'reset'): void {
    const zoom = step === 'reset' ? 0 : clampZoom(this.ui.zoom + step);
    if (zoom !== this.ui.zoom) this.updateUi({ zoom });
  }

  /* ----- Opening ----------------------------------------------------------- */

  private createTerminal(target: Target, tmux: string | null): TerminalSession {
    const session = new TerminalSession(this.api, this.events, target, {
      tmux,
      look: this.lookFor(target.kind === 'host' ? target.hostId : null),
      callbacks: {
        onBell: (s) => this.onBell(s),
        onAttention: (s, reason) => this.onAttention(s, reason),
        onTmuxSessions: (s, available, sessions) => {
          if (s.hostId) this.setFound(s.hostId, available, sessions);
        },
        onReady: () => {
          // The engine counted the connection: refresh "last used" and the counter.
          void call('hosts.list', {}).then(
            ({ hosts }) => this.setHosts(hosts),
            () => undefined,
          );
        },
      },
    });
    session.subscribe(() => this.changed());
    this.terms.set(session.tag, session);
    return session;
  }

  /**
   * Opens a terminal to a saved host: in a new tab, or as the second pane of
   * the current tab. `tmux`: a session to re-attach; by default a new one
   * when the host has resumable sessions on.
   */
  openHost(
    hostId: string,
    options: { tmux?: string | null; split?: 'h' | 'v' } = {},
  ): string | null {
    const host = this.host(hostId);
    if (!host) return null;
    // Already open here: show it instead of attaching twice.
    if (options.tmux) {
      const open = [...this.terms.values()].find(
        (s) => s.requestedTmux === options.tmux && !s.isDisposed,
      );
      if (open) {
        this.focusTerm(open.tag);
        return open.tag;
      }
    }
    const tmux = options.tmux ?? (host.tmux ? newTmuxName() : null);
    const session = this.createTerminal({ kind: 'host', hostId, title: host.name }, tmux);
    this.place(session.tag, options.split);
    return session.tag;
  }

  openAdhoc(target: Omit<AdhocConnect, 'cols' | 'rows'>): string {
    const title = `${target.username}@${target.host}${target.port === 22 ? '' : `:${target.port}`}`;
    const session = this.createTerminal({ kind: 'adhoc', ...target, title }, null);
    this.place(session.tag);
    return session.tag;
  }

  /** A new terminal with the same login as the active one (the + button). */
  duplicateActive(split?: 'h' | 'v'): void {
    const session = this.activeSession();
    if (!session) return;
    if (session.target.kind === 'host')
      this.openHost(session.target.hostId, { ...(split && { split }) });
    else if (!split) {
      const { host, port, username, auth } = session.target;
      this.openAdhoc({ host, port, username, auth });
    } else {
      const { host, port, username, auth, title } = session.target;
      const copy = this.createTerminal({ kind: 'adhoc', host, port, username, auth, title }, null);
      this.place(copy.tag, split);
    }
  }

  private place(tag: string, split?: 'h' | 'v') {
    const tab = this.currentTab();
    if (split && tab && tab.panes.length === 1) {
      tab.panes.push(tag);
      tab.split = split;
      tab.active = 1;
    } else {
      const created: Tab = { id: `tab${++nextTab}`, panes: [tag], split: 'none', active: 0 };
      const index = tab ? this.tabs.indexOf(tab) + 1 : this.tabs.length;
      this.tabs.splice(index, 0, created);
      this.activeTab = created.id;
    }
    this.layoutChanged();
  }

  /* ----- Tabs and panes ---------------------------------------------------- */

  currentTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTab);
  }

  activeSession(): TerminalSession | undefined {
    const tab = this.currentTab();
    const tag = tab?.panes[tab.active];
    return tag ? this.terms.get(tag) : undefined;
  }

  tabOf(tag: string): Tab | undefined {
    return this.tabs.find((t) => t.panes.includes(tag));
  }

  showTab(id: string | null): void {
    if (id !== null && !this.tabs.some((t) => t.id === id)) return;
    const already = this.activeTab === id;
    this.activeTab = id;
    this.layoutChanged();
    // Keys go to the terminal on screen; a newly shown tab focuses itself when it renders.
    if (already && id !== null) this.activeSession()?.focus();
  }

  showHome(): void {
    this.showTab(null);
  }

  cycleTab(step: 1 | -1): void {
    if (this.tabs.length === 0) return;
    const index = this.tabs.findIndex((t) => t.id === this.activeTab);
    // From Hosts, forward goes to the first tab, back to the last.
    const next =
      index === -1
        ? step === 1
          ? 0
          : this.tabs.length - 1
        : (index + step + this.tabs.length) % this.tabs.length;
    this.showTab(this.tabs[next]?.id ?? null);
  }

  focusTerm(tag: string): void {
    const tab = this.tabOf(tag);
    if (!tab) return;
    tab.active = Math.max(0, tab.panes.indexOf(tag));
    this.activeTab = tab.id;
    this.layoutChanged();
    setTimeout(() => this.terms.get(tag)?.focus(), 0);
  }

  setActivePane(tabId: string, index: number): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || index < 0 || index >= tab.panes.length || tab.active === index) return;
    tab.active = index;
    this.changed();
  }

  cyclePane(): void {
    const tab = this.currentTab();
    if (!tab || tab.panes.length < 2) return;
    tab.active = (tab.active + 1) % tab.panes.length;
    this.changed();
    this.activeSession()?.focus();
  }

  setSplit(tabId: string, split: 'h' | 'v'): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.panes.length < 2) return;
    tab.split = split;
    this.layoutChanged();
  }

  moveTab(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) {
      return;
    }
    const [tab] = this.tabs.splice(from, 1);
    if (tab) this.tabs.splice(to, 0, tab);
    this.layoutChanged();
  }

  /** Closes one terminal (tmux keeps running on the host); its tab goes when empty. */
  closeTerm(tag: string): void {
    const session = this.terms.get(tag);
    session?.dispose();
    this.terms.delete(tag);
    this.pinnedTags.delete(tag);
    this.tagAliases.delete(tag);
    const tab = this.tabOf(tag);
    if (tab) {
      tab.panes = tab.panes.filter((t) => t !== tag);
      tab.split = 'none';
      tab.active = 0;
      if (tab.panes.length === 0) {
        const index = this.tabs.indexOf(tab);
        this.tabs.splice(index, 1);
        if (this.activeTab === tab.id) {
          this.activeTab = (this.tabs[Math.min(index, this.tabs.length - 1)] ?? null)?.id ?? null;
        }
      }
    }
    this.layoutChanged();
  }

  closeTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    for (const tag of [...tab.panes]) this.closeTerm(tag);
  }

  /** Every terminal; tmux sessions keep running on their hosts. */
  closeAll(): void {
    for (const tag of [...this.terms.keys()]) this.closeTerm(tag);
    this.activeTab = null;
    this.layoutChanged();
  }

  /** Visibility, the saved layout and a re-render after any tab or pane change. */
  private layoutChanged(save = true) {
    const tab = this.currentTab();
    for (const [tag, session] of this.terms) session.setVisible(tab?.panes.includes(tag) ?? false);
    this.changed();
    if (!save) return;
    const tabs = this.tabs
      .map((t) => ({
        split: t.panes.length === 2 ? t.split : ('none' as Split),
        panes: t.panes.flatMap((tag) => {
          const s = this.terms.get(tag);
          if (!s || s.target.kind !== 'host') return [];
          return [{ hostId: s.target.hostId, session: s.getSnapshot().tmux ?? s.requestedTmux }];
        }),
      }))
      .filter((t) => t.panes.length > 0)
      .slice(0, 32)
      .map((t) => (t.panes.length === 2 ? t : { ...t, split: 'none' as Split }));
    const saved = this.tabs.filter((t) =>
      t.panes.some((tag) => this.terms.get(tag)?.target.kind === 'host'),
    );
    const active = tab ? saved.indexOf(tab) : -1;
    this.ui = { ...this.ui, layout: { tabs, active: Math.min(active, 31) } };
    this.scheduleSave();
  }

  /* ----- Names, pins, favorites -------------------------------------------- */

  /** The name shown for a terminal: its alias, else the host's name. */
  nameOf(session: TerminalSession): string {
    const tmux = session.getSnapshot().tmux ?? session.requestedTmux;
    const alias = (tmux && this.aliasOf(tmux)) || this.tagAliases.get(session.tag);
    if (alias) return alias;
    return session.target.kind === 'host'
      ? (this.host(session.target.hostId)?.name ?? 'Host')
      : session.target.title;
  }

  hostNameOf(session: TerminalSession): string {
    return session.target.kind === 'host'
      ? (this.host(session.target.hostId)?.name ?? 'Host')
      : session.target.title;
  }

  private aliasOf(tmux: string): string | undefined {
    return this.ui.aliases.find((a) => a.session === tmux)?.label;
  }

  /** Renames a terminal or a tmux session (empty resets to the host name). */
  rename(key: { tag?: string | null; session?: string | null }, label: string): void {
    const clean = printable(label, 200).trim().slice(0, MAX_ALIAS_LENGTH);
    const session = key.session ?? (key.tag ? this.terms.get(key.tag)?.getSnapshot().tmux : null);
    if (session) {
      const aliases = this.ui.aliases.filter((a) => a.session !== session);
      if (clean) aliases.unshift({ session, label: clean });
      this.updateUi({ aliases: aliases.slice(0, 500) });
    } else if (key.tag) {
      if (clean) this.tagAliases.set(key.tag, clean);
      else this.tagAliases.delete(key.tag);
      this.changed();
    }
  }

  isPinned(row: { tag: string | null; session: string | null }): boolean {
    if (row.session) return this.ui.favorites.some((f) => f.session === row.session);
    return row.tag !== null && this.pinnedTags.has(row.tag);
  }

  /** Pins a tmux session (saved) or a plain shell (this run only). */
  togglePin(row: { tag: string | null; session: string | null; hostId: string | null }): void {
    if (row.session && row.hostId) {
      const pinned = this.ui.favorites.some((f) => f.session === row.session);
      this.updateUi({
        favorites: pinned
          ? this.ui.favorites.filter((f) => f.session !== row.session)
          : [...this.ui.favorites, { hostId: row.hostId, session: row.session }].slice(0, 32),
      });
    } else if (row.tag) {
      if (this.pinnedTags.has(row.tag)) this.pinnedTags.delete(row.tag);
      else this.pinnedTags.add(row.tag);
      this.changed();
    }
  }

  isHostFavorite(hostId: string): boolean {
    return this.ui.favorites.some((f) => f.hostId === hostId && f.session === null);
  }

  toggleHostFavorite(hostId: string): void {
    const has = this.isHostFavorite(hostId);
    this.updateUi({
      favorites: has
        ? this.ui.favorites.filter((f) => !(f.hostId === hostId && f.session === null))
        : [...this.ui.favorites, { hostId, session: null }].slice(0, 32),
    });
  }

  /** The toolbar star: the active terminal's tmux session, else its host. */
  toggleActiveFavorite(): void {
    const session = this.activeSession();
    if (!session) return;
    const tmux = session.getSnapshot().tmux;
    if (tmux && session.hostId)
      this.togglePin({ tag: session.tag, session: tmux, hostId: session.hostId });
    else if (session.hostId) this.toggleHostFavorite(session.hostId);
    else this.togglePin({ tag: session.tag, session: null, hostId: null });
  }

  activeIsFavorite(): boolean {
    const session = this.activeSession();
    if (!session) return false;
    const tmux = session.getSnapshot().tmux;
    if (tmux) return this.isPinned({ tag: session.tag, session: tmux });
    if (session.hostId) return this.isHostFavorite(session.hostId);
    return this.pinnedTags.has(session.tag);
  }

  /** The favorites bar, in pin order. */
  favorites(): Favorite[] {
    const rows = this.rows();
    const list: Favorite[] = [];
    for (const favorite of this.ui.favorites) {
      const host = this.host(favorite.hostId);
      if (!host) continue;
      if (favorite.session === null) {
        list.push({
          key: `host:${host.id}`,
          hostId: host.id,
          session: null,
          tag: null,
          name: host.name,
          hostName: host.name,
          state: 'host',
          busy: false,
          attention: false,
        });
        continue;
      }
      const row = rows.find((r) => r.session === favorite.session);
      list.push({
        key: `${host.id}/${favorite.session}`,
        hostId: host.id,
        session: favorite.session,
        tag: row?.tag ?? null,
        name: this.aliasOf(favorite.session) ?? host.name,
        hostName: host.name,
        state: row?.state ?? 'detached',
        busy: row?.busy ?? false,
        attention: row?.attention ?? false,
      });
    }
    for (const tag of this.pinnedTags) {
      const session = this.terms.get(tag);
      const row = rows.find((r) => r.tag === tag);
      if (!session || !row) continue;
      list.push({
        key: `tag:${tag}`,
        hostId: session.hostId,
        session: null,
        tag,
        name: this.nameOf(session),
        hostName: this.hostNameOf(session),
        state: row.state,
        busy: row.busy,
        attention: row.attention,
      });
    }
    return list;
  }

  /** A favorite's click: show it (or hide it when it is on screen), open it, or open its host. */
  openFavorite(favorite: Favorite): void {
    if (favorite.tag) {
      const tab = this.tabOf(favorite.tag);
      if (tab && tab.id === this.activeTab && tab.panes[tab.active] === favorite.tag) {
        this.showHome();
      } else this.focusTerm(favorite.tag);
      return;
    }
    if (favorite.hostId === null) return;
    this.openHost(favorite.hostId, favorite.session ? { tmux: favorite.session } : {});
  }

  /* ----- Sessions on hosts ------------------------------------------------- */

  setFound(hostId: string, available: boolean, sessions: TmuxSessionInfo[]): void {
    this.found.set(hostId, { available, sessions, at: Date.now() });
    this.changed();
  }

  /** Detached tmux sessions known for a host that are not open here. */
  detachedOn(hostId: string): TmuxSessionInfo[] {
    const open = new Set(
      [...this.terms.values()].map((s) => s.getSnapshot().tmux ?? s.requestedTmux),
    );
    return (this.found.get(hostId)?.sessions ?? []).filter(
      (s) => !open.has(s.name) && !this.ui.forgotten.includes(s.name),
    );
  }

  /** A live terminal to the host whose connection can run tmux commands. */
  private liveOn(hostId: string): TerminalSession | undefined {
    return [...this.terms.values()].find(
      (s) => s.hostId === hostId && s.getSnapshot().state === 'connected',
    );
  }

  /** Refreshes the session lists over live connections (the dock opening). */
  refreshFound(): void {
    const done = new Set<string>();
    for (const session of this.terms.values()) {
      const hostId = session.hostId;
      if (hostId === null || done.has(hostId) || !this.host(hostId)?.tmux) continue;
      if (session.refreshTmuxSessions()) done.add(hostId);
    }
  }

  /** Lists a host's sessions: over a live terminal, else with a one-shot login. */
  listSessions(hostId: string): void {
    const live = this.liveOn(hostId);
    if (live?.refreshTmuxSessions()) return;
    this.startProbe(hostId, null);
  }

  /** Ends a tmux session on its host (after the user confirmed); open terminals of it close. */
  endOnHost(hostId: string, name: string): void {
    for (const session of [...this.terms.values()]) {
      if ((session.getSnapshot().tmux ?? session.requestedTmux) === name)
        this.closeTerm(session.tag);
    }
    const found = this.found.get(hostId);
    if (found) {
      this.found.set(hostId, { ...found, sessions: found.sessions.filter((s) => s.name !== name) });
    }
    this.updateUi({
      favorites: this.ui.favorites.filter((f) => f.session !== name),
      aliases: this.ui.aliases.filter((a) => a.session !== name),
    });
    const live = this.liveOn(hostId);
    if (!live?.endTmuxSession(name)) this.startProbe(hostId, name);
  }

  /** Hides a detached session from the dock (it keeps running on the host). */
  forget(name: string): void {
    if (this.ui.forgotten.includes(name)) return;
    this.updateUi({ forgotten: [name, ...this.ui.forgotten].slice(0, 500) });
  }

  startProbe(hostId: string, end: string | null): HostProbe {
    const probe = new HostProbe(this.api, this.events, hostId, end, (available, sessions) =>
      this.setFound(hostId, available, sessions),
    );
    this.probes = [...this.probes.slice(-7), probe];
    probe.subscribe(() => {
      // A finished probe without an error goes; one with an error stays for its dialog.
      const snapshot = probe.getSnapshot();
      if (snapshot.done && !snapshot.error && !snapshot.hostKeyChanged) {
        this.probes = this.probes.filter((p) => p !== probe);
      }
      this.changed();
    });
    void probe.start();
    this.changed();
    return probe;
  }

  /** The latest probe of a host, for its sessions dialog. */
  probeOf(hostId: string): HostProbe | undefined {
    return this.probes.findLast((p) => p.hostId === hostId);
  }

  closeProbe(probe: HostProbe): void {
    probe.dispose();
    this.probes = this.probes.filter((p) => p !== probe);
    this.changed();
  }

  /* ----- Dock rows --------------------------------------------------------- */

  rows(): DockRow[] {
    if (this.rowsCache?.version === this.version) return this.rowsCache.rows;
    const tab = this.currentTab();
    const open: OpenTerminal[] = [...this.terms.values()].map((session) => {
      const snapshot = session.getSnapshot();
      return {
        tag: session.tag,
        hostId: session.hostId,
        hostName: this.hostNameOf(session),
        session: snapshot.tmux ?? session.requestedTmux,
        snapshot,
        shown: tab?.panes.includes(session.tag) ?? false,
        createdAt: session.createdAt,
      };
    });
    const hosts = [...this.found.entries()].flatMap(([hostId, found]) => {
      const host = this.host(hostId);
      return host ? [{ hostId, hostName: host.name, sessions: found.sessions }] : [];
    });
    const aliases = new Map<string, string>(this.ui.aliases.map((a) => [a.session, a.label]));
    for (const [tag, label] of this.tagAliases) aliases.set(tag, label);
    const pinned = new Set<string>([
      ...this.ui.favorites.flatMap((f) => (f.session ? [f.session] : [])),
      ...this.pinnedTags,
    ]);
    const rows = sortRows(
      buildRows({ open, hosts, aliases, pinned, forgotten: new Set(this.ui.forgotten) }),
      [...pinned],
    );
    this.rowsCache = { version: this.version, rows };
    return rows;
  }

  /** Opens a dock or switcher row: show an open terminal, or re-attach a session. */
  openRow(row: DockRow): void {
    if (row.tag) {
      const session = this.terms.get(row.tag);
      const state = session?.getSnapshot().state;
      if (session && (state === 'disconnected' || state === 'denied')) session.reconnectNow();
      this.focusTerm(row.tag);
      return;
    }
    if (row.hostId && row.session) this.openHost(row.hostId, { tmux: row.session });
  }

  setSwitcherOpen(open: boolean): void {
    this.switcherOpen = open;
    this.changed();
  }

  setDockOpen(open: boolean): void {
    this.dockOpen = open;
    if (open) this.refreshFound();
    this.changed();
  }

  /* ----- Attention --------------------------------------------------------- */

  /** A background terminal rang (BEL). */
  private onBell(session: TerminalSession) {
    if (!session.bellOn) return;
    const now = Date.now();
    if (now - this.rangAt < BELL_GAP_MS) return;
    this.rangAt = now;
    this.api.attention();
    if (this.ui.sound) playChime();
    this.notify(session, `${this.nameOf(session)} rang`);
  }

  /** An agent finished or asks something: the completion alert, at most every 30 s. */
  private onAttention(session: TerminalSession, reason: 'finished' | 'choice') {
    if (!session.bellOn) return;
    const now = Date.now();
    if (now - this.chimeAt < CHIME_COOLDOWN_MS) return;
    this.chimeAt = now;
    // A BEL the agent sent at the same moment has already rung.
    if (this.ui.sound && now - this.rangAt >= BELL_GAP_MS) {
      this.rangAt = now;
      playChime();
    }
    this.api.attention();
    const name = this.nameOf(session);
    this.notify(session, reason === 'finished' ? `${name}: agent finished` : `${name} needs you`);
  }

  private notify(session: TerminalSession, title: string) {
    if (!this.ui.notifications) return;
    this.api.notify({
      title: printable(title, 120),
      body: printable(this.hostNameOf(session), 200),
      tag: session.tag,
    });
  }

  /* ----- Locking ----------------------------------------------------------- */

  /** Vault locked: terminals keep running; prompts are cancelled by the engine. */
  flushSave(): void {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    void call('ui.save', this.ui).catch(() => undefined);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function printable(text: string, max: number): string {
  return text.replace(CONTROL, '').slice(0, max);
}
