/**
 * Add / Edit Host: name, address, port, user, login (key from the vault,
 * the SSH agent, or password), type, group, tags, colour, resumable sessions
 * (tmux), terminal look, jump host, agent forwarding, file roots and upload
 * folder, the clipboard (OSC 52) choice, saved port forwards and notes. The
 * form holds no secret: a password login asks when connecting (or uses the
 * saved password).
 *
 * Modelled on Jarvis NG's host forms (apps/web/src/machines/HostForms.tsx),
 * same owner.
 */
import { useState } from 'react';
import {
  HOST_PATTERN,
  MAX_FILE_ROOTS,
  MAX_SAVED_FORWARDS,
  TAG_PATTERN,
  USER_PATTERN,
  type AgentKey,
  type AgentSource,
  type HostInfo,
  type HostInput,
  type KeyInfo,
  type SavedForward,
} from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import {
  cleanForward,
  describeForward,
  EMPTY_FORWARD,
  ForwardFields,
  validateForward,
} from '../components/Forwards.js';
import { Icon } from '../components/icons.js';
import { FONTS, SCHEMES } from '../terminal/themes.js';
import { parseTags } from './hostModel.js';

export const HOST_COLORS = [
  '',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
];

const HOST_RE = new RegExp(HOST_PATTERN);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const USER_RE = new RegExp(USER_PATTERN);
const TAG_RE = new RegExp(TAG_PATTERN);

export const EMPTY_HOST: HostInput = {
  name: '',
  address: '',
  port: 22,
  username: '',
  auth: { kind: 'password' },
  os: 'linux',
  group: '',
  tags: [],
  notes: '',
  color: '',
  // Opt-in: tmux changes how scrollback and some keys behave.
  tmux: false,
  jumpHostId: null,
  proxyJump: '',
  scheme: '',
  font: '',
  // Off by default: a forwarded agent lets the host log in elsewhere as you.
  agentForward: false,
  fileRoots: [],
  uploadDir: '',
  osc52: 'ask',
  forwards: [],
};

/** Is this platform likely to have Pageant (Windows)? */
const WINDOWS = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

function newForwardId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `f_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** One absolute folder per line; blank lines dropped. */
export function parseRoots(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function inputOf(host: HostInfo): HostInput {
  const {
    id: _id,
    createdAt: _createdAt,
    lastUsedAt: _lastUsedAt,
    connectCount: _connectCount,
    ...input
  } = host;
  return input;
}

/** Checks the form like the engine will; returns the first problem or null. */
export function validateHost(host: HostInput): string | null {
  if (!host.address || host.address.length > 253 || !HOST_RE.test(host.address)) {
    return 'Enter a host name or IP address (no spaces, no URL)';
  }
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) {
    return 'The port must be between 1 and 65535';
  }
  if (!USER_RE.test(host.username)) return 'Enter the SSH user name';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(host.name) || host.name.length > 64) {
    return 'The name must be one line of at most 64 characters';
  }
  if (host.tags.length > 16) return 'At most 16 tags';
  if (host.tags.some((tag) => !TAG_RE.test(tag)))
    return 'Tags are single words of up to 32 characters';
  if (host.group.length > 64) return 'The group name is too long';
  if (host.notes.length > 4000) return 'The notes are too long (4000 characters at most)';
  if (host.fileRoots.length > MAX_FILE_ROOTS) return `At most ${MAX_FILE_ROOTS} file roots`;
  if (host.fileRoots.some((root) => !root.startsWith('/') || CONTROL.test(root))) {
    return 'File roots are absolute folders, one per line (e.g. /srv/app)';
  }
  if (host.uploadDir && (!/^(\/|~\/|~$)/.test(host.uploadDir) || CONTROL.test(host.uploadDir))) {
    return 'The upload folder starts with / or ~/';
  }
  if (host.forwards.length > MAX_SAVED_FORWARDS) return `At most ${MAX_SAVED_FORWARDS} forwards`;
  for (const forward of host.forwards) {
    const problem = validateForward(forward);
    if (problem) return `Port forward ${describeForward(forward)}: ${problem}`;
  }
  return null;
}

export function HostForm({
  title,
  id,
  initial,
  keys,
  hosts,
  onSaved,
  onClose,
  onManageKeys,
}: {
  title: string;
  /** Editing this host; undefined adds a new one. */
  id?: string;
  initial: HostInput;
  keys: KeyInfo[];
  hosts: HostInfo[];
  onSaved(host: HostInfo): void;
  onClose(): void;
  onManageKeys?: () => void;
}) {
  const [host, setHost] = useState<HostInput>(initial);
  const [port, setPort] = useState(String(initial.port));
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [roots, setRoots] = useState(initial.fileRoots.join('\n'));
  const [agentKeys, setAgentKeys] = useState<{ message: string; keys: AgentKey[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<HostInput>) => setHost((current) => ({ ...current, ...change }));
  const groups = [...new Set(hosts.map((h) => h.group).filter(Boolean))].sort();
  const jumpChoices = hosts.filter((h) => h.id !== id);
  const keyId = host.auth.kind === 'key' ? host.auth.keyId : '';

  const save = async () => {
    const value: HostInput = {
      ...host,
      name: host.name.trim() || host.address.trim(),
      address: host.address.trim(),
      username: host.username.trim(),
      group: host.group.trim(),
      port: Number(port),
      tags: parseTags(tags),
      fileRoots: parseRoots(roots),
      uploadDir: host.uploadDir.trim(),
      forwards: host.forwards.map((f) => ({ ...f, ...cleanForward(f), label: f.label.trim() })),
    };
    const invalid = validateHost(value);
    if (invalid) return setProblem(invalid);
    setProblem(null);
    setBusy(true);
    try {
      onSaved(await call('hosts.save', { ...(id !== undefined && { id }), host: value }));
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      onSubmit={() => void save()}
      submitLabel={id ? 'Save' : 'Add host'}
      busy={busy}
      wide
      className="host-form"
    >
      <div className="form-grid">
        <div className="system-form-group span-2">
          <label htmlFor="hf-name">Name</label>
          <input
            id="hf-name"
            className="system-input"
            value={host.name}
            maxLength={64}
            placeholder="e.g. web-1 (defaults to the address)"
            onChange={(e) => set({ name: e.target.value })}
            autoFocus
          />
        </div>
        <div className="system-form-group span-2">
          <label htmlFor="hf-address">Address</label>
          <input
            id="hf-address"
            className="system-input"
            value={host.address}
            spellCheck={false}
            autoComplete="off"
            placeholder="server.example.com or 10.0.0.5"
            onChange={(e) => set({ address: e.target.value })}
          />
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-port">Port</label>
          <input
            id="hf-port"
            className="system-input"
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-user">User</label>
          <input
            id="hf-user"
            className="system-input"
            value={host.username}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set({ username: e.target.value })}
          />
        </div>
        <div className="system-form-group span-2">
          <span className="system-form-label">Login</span>
          <div className="segmented" role="group" aria-label="Login">
            <button
              type="button"
              aria-pressed={host.auth.kind === 'password'}
              onClick={() => set({ auth: { kind: 'password' } })}
            >
              Password
            </button>
            <button
              type="button"
              aria-pressed={host.auth.kind === 'key'}
              disabled={keys.length === 0}
              title={keys.length === 0 ? 'Generate or import a key first' : undefined}
              onClick={() => {
                const first = keys[0];
                if (first) set({ auth: { kind: 'key', keyId: first.id } });
              }}
            >
              Key from the vault
            </button>
            <button
              type="button"
              aria-pressed={host.auth.kind === 'agent'}
              onClick={() => set({ auth: { kind: 'agent', agent: 'system' } })}
            >
              SSH agent
            </button>
          </div>
          {host.auth.kind === 'agent' ? (
            <div className="agent-choice">
              <select
                aria-label="Agent"
                className="system-input"
                value={host.auth.agent}
                onChange={(e) => {
                  setAgentKeys(null);
                  set({ auth: { kind: 'agent', agent: e.target.value as AgentSource } });
                }}
              >
                <option value="system">
                  {WINDOWS ? 'Windows OpenSSH agent' : 'System agent (SSH_AUTH_SOCK)'}
                </option>
                <option value="pageant">Pageant (PuTTY)</option>
              </select>
              <button
                type="button"
                className="system-btn ghost small"
                onClick={() => {
                  if (host.auth.kind !== 'agent') return;
                  call('agent.list', { agent: host.auth.agent }).then(
                    (found) => setAgentKeys(found),
                    (error: unknown) => setAgentKeys({ message: messageOf(error), keys: [] }),
                  );
                }}
              >
                Show its keys
              </button>
              {agentKeys && (
                <div className="agent-keys" data-testid="agent-keys">
                  {agentKeys.message && <span className="system-hint">{agentKeys.message}</span>}
                  {agentKeys.keys.map((key) => (
                    <span key={key.fingerprint} className="item-mono">
                      {key.algorithm} {key.fingerprint} {key.comment}
                    </span>
                  ))}
                </div>
              )}
              <span className="system-hint">
                The agent signs the login; its keys never reach this app.
              </span>
            </div>
          ) : host.auth.kind === 'key' ? (
            <select
              aria-label="Key"
              className="system-input"
              value={keyId}
              onChange={(e) => set({ auth: { kind: 'key', keyId: e.target.value } })}
            >
              {!keys.some((k) => k.id === keyId) && <option value={keyId}>(missing key)</option>}
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.label} ({key.algorithm}, {key.fingerprint.slice(7, 19)}…)
                </option>
              ))}
            </select>
          ) : (
            <span className="system-hint">
              The password is asked when you connect (or the one saved in the vault is used).
              {keys.length === 0 && onManageKeys && (
                <>
                  {' '}
                  <button type="button" className="link-btn" onClick={onManageKeys}>
                    Create a key
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-os">Type</label>
          <select
            id="hf-os"
            className="system-input"
            value={host.os}
            onChange={(e) => set({ os: e.target.value === 'windows' ? 'windows' : 'linux' })}
          >
            <option value="linux">Linux / Unix</option>
            <option value="windows">Windows (OpenSSH Server)</option>
          </select>
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-group">Group</label>
          <input
            id="hf-group"
            className="system-input"
            list="hf-groups"
            value={host.group}
            maxLength={64}
            placeholder="Ungrouped"
            onChange={(e) => set({ group: e.target.value })}
          />
          <datalist id="hf-groups">
            {groups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>
        </div>
        <div className="system-form-group span-2">
          <label htmlFor="hf-tags">Tags</label>
          <input
            id="hf-tags"
            className="system-input"
            value={tags}
            placeholder="prod, eu, web"
            onChange={(e) => setTags(e.target.value)}
          />
        </div>
        <div className="system-form-group span-2">
          <span className="system-form-label">Colour</span>
          <div className="color-swatches" role="radiogroup" aria-label="Colour">
            {HOST_COLORS.map((color) => (
              <button
                key={color || 'none'}
                type="button"
                role="radio"
                aria-checked={host.color === color}
                aria-label={color || 'No colour'}
                className={`color-swatch${color ? '' : ' none'}`}
                style={color ? { background: color } : undefined}
                onClick={() => set({ color })}
              />
            ))}
          </div>
        </div>
        <label className="system-check span-2">
          <input
            type="checkbox"
            checked={host.tmux}
            onChange={(e) => set({ tmux: e.target.checked })}
          />
          <span>
            Resumable sessions (tmux): terminals keep running on the host when you close them or the
            connection drops, and re-attach later. Needs tmux on a Linux host; without it you get a
            plain shell.
          </span>
        </label>
        <div className="system-form-group">
          <label htmlFor="hf-scheme">Terminal colours</label>
          <select
            id="hf-scheme"
            className="system-input"
            value={host.scheme}
            onChange={(e) => set({ scheme: e.target.value })}
          >
            <option value="">App default</option>
            {SCHEMES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-font">Terminal font</label>
          <select
            id="hf-font"
            className="system-input"
            value={host.font}
            onChange={(e) => set({ font: e.target.value })}
          >
            <option value="">App default</option>
            {FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="system-form-group span-2">
          <label htmlFor="hf-jump">Jump host</label>
          <select
            id="hf-jump"
            className="system-input"
            value={host.jumpHostId ?? ''}
            onChange={(e) => set({ jumpHostId: e.target.value || null })}
          >
            <option value="">None (direct)</option>
            {jumpChoices.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <span className="system-hint">
            Connects through that host first (ProxyJump); each hop uses its own login and host key.
            {host.proxyJump && host.jumpHostId === null && (
              <>
                {' '}
                From ~/.ssh/config: ProxyJump {host.proxyJump} (used while no jump host is chosen).
              </>
            )}
          </span>
        </div>
        <label className="system-check span-2 warning-check">
          <input
            type="checkbox"
            checked={host.agentForward}
            onChange={(e) => set({ agentForward: e.target.checked })}
          />
          <span>
            <Icon name="warning" /> Forward my SSH agent to this host. Anyone with root on the host
            can then use your agent&apos;s keys while you are connected. Only for hosts you trust.
          </span>
        </label>
        <div className="system-form-group span-2">
          <label htmlFor="hf-roots">File roots</label>
          <textarea
            id="hf-roots"
            className="system-textarea roots"
            value={roots}
            spellCheck={false}
            placeholder={'Empty: the whole disk\n/srv/app\n/var/log'}
            onChange={(e) => setRoots(e.target.value)}
          />
          <span className="system-hint">
            The file browser and uploads stay inside these folders (symlinks are resolved first).
          </span>
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-upload">Upload folder</label>
          <input
            id="hf-upload"
            className="system-input"
            value={host.uploadDir}
            spellCheck={false}
            placeholder="~/uploads"
            onChange={(e) => set({ uploadDir: e.target.value })}
          />
        </div>
        <div className="system-form-group">
          <label htmlFor="hf-osc52">Programs copying to the clipboard</label>
          <select
            id="hf-osc52"
            className="system-input"
            value={host.osc52}
            onChange={(e) => set({ osc52: e.target.value as HostInput['osc52'] })}
          >
            <option value="ask">Ask each time</option>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
        </div>
        <div className="system-form-group span-2">
          <span className="system-form-label">Port forwarding</span>
          {host.forwards.map((forward, index) => (
            <SavedForwardEditor
              key={forward.id}
              forward={forward}
              index={index}
              onChange={(next) =>
                set({ forwards: host.forwards.map((f) => (f.id === forward.id ? next : f)) })
              }
              onRemove={() => set({ forwards: host.forwards.filter((f) => f.id !== forward.id) })}
            />
          ))}
          {host.forwards.length < MAX_SAVED_FORWARDS && (
            <button
              type="button"
              className="system-btn ghost small add-forward"
              onClick={() =>
                set({
                  forwards: [
                    ...host.forwards,
                    { ...EMPTY_FORWARD, id: newForwardId(), auto: false, label: '' },
                  ],
                })
              }
            >
              <Icon name="plus" /> Add a forward
            </button>
          )}
        </div>
        <div className="system-form-group span-2">
          <label htmlFor="hf-notes">Notes</label>
          <textarea
            id="hf-notes"
            className="system-textarea notes"
            value={host.notes}
            maxLength={4000}
            placeholder="Anything worth remembering about this host (no passwords)"
            onChange={(e) => set({ notes: e.target.value })}
          />
        </div>
      </div>
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

function SavedForwardEditor({
  forward,
  index,
  onChange,
  onRemove,
}: {
  forward: SavedForward;
  index: number;
  onChange(forward: SavedForward): void;
  onRemove(): void;
}) {
  return (
    <div className="saved-forward" data-testid="saved-forward">
      <div className="saved-forward-head">
        <input
          className="system-input"
          aria-label="Forward name"
          placeholder="Name (optional), e.g. database"
          value={forward.label}
          maxLength={64}
          onChange={(e) => onChange({ ...forward, label: e.target.value })}
        />
        <label className="system-check">
          <input
            type="checkbox"
            checked={forward.auto}
            onChange={(e) => onChange({ ...forward, auto: e.target.checked })}
          />
          <span>Start automatically</span>
        </label>
        <button
          type="button"
          className="icon-btn"
          aria-label="Remove this forward"
          title="Remove"
          onClick={onRemove}
        >
          <Icon name="trash" />
        </button>
      </div>
      <ForwardFields
        spec={forward}
        idPrefix={`hf-fwd-${index}`}
        onChange={(spec) => onChange({ ...forward, ...spec })}
      />
    </div>
  );
}
