/**
 * The engine asks for a password, a key passphrase or keyboard-interactive
 * answers. Inputs are uncontrolled: the values are read once on submit, sent
 * to the engine and cleared; nothing is kept in React state.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { CredentialPrompt } from '../terminal/connection.js';
import { Icon } from './icons.js';
import { useModalDialog } from './useModalDialog.js';

export function CredentialDialog({
  prompt,
  onAnswer,
}: {
  prompt: CredentialPrompt;
  onAnswer(answers: string[] | null, remember: boolean): void;
}) {
  const ref = useModalDialog(() => onAnswer(null, false));
  const form = useRef<HTMLFormElement>(null);
  const [remember, setRemember] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const inputs = [
      ...(form.current?.querySelectorAll('input[data-answer]') ?? []),
    ] as HTMLInputElement[];
    const answers = inputs.map((input) => input.value);
    for (const input of inputs) input.value = '';
    onAnswer(answers, remember);
  };

  return (
    <dialog ref={ref} className="terminal-decision" aria-labelledby="credential-title">
      <form ref={form} onSubmit={submit} noValidate>
        <div className="terminal-decision-body">
          <div className="terminal-decision-heading">
            <span className="terminal-decision-icon">
              <Icon name={prompt.kind === 'passphrase' ? 'key' : 'lock'} />
            </span>
            <h3 id="credential-title">{prompt.title}</h3>
          </div>
          {prompt.message && (
            <p
              className={`terminal-decision-note ${/try again/.test(prompt.message) ? 'error' : ''}`}
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {prompt.message}
            </p>
          )}
          {prompt.prompts.map((p, i) => (
            <div className="system-form-group" key={i}>
              <label htmlFor={`credential-${i}`}>{p.label}</label>
              <input
                id={`credential-${i}`}
                data-answer=""
                className="system-input"
                type={p.echo ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoFocus={i === 0}
              />
            </div>
          ))}
          {prompt.canRemember && (
            <label className="system-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              {prompt.kind === 'passphrase'
                ? 'Save the passphrase in the vault'
                : 'Save the password in the vault'}
            </label>
          )}
        </div>
        <div className="terminal-decision-actions">
          <button
            type="button"
            className="terminal-decision-btn"
            onClick={() => onAnswer(null, false)}
          >
            Cancel
          </button>
          <button type="submit" className="terminal-decision-btn primary">
            Log in
          </button>
        </div>
      </form>
    </dialog>
  );
}
