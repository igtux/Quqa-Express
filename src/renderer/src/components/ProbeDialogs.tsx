/** Host-key and credential prompts of a one-shot "list sessions" login (HostProbe). */
import { useSyncExternalStore } from 'react';
import type { HostProbe } from '../terminal/connection.js';
import { CredentialDialog } from './CredentialDialog.js';
import { HostKeyChangedScreen } from './HostKeyChanged.js';
import { HostKeyDialog } from './HostKeyDialog.js';

export function ProbeDialogs({ probe, onClose }: { probe: HostProbe; onClose(): void }) {
  const snapshot = useSyncExternalStore(probe.subscribe, probe.getSnapshot);
  return (
    <>
      {snapshot.hostKey && (
        <HostKeyDialog
          key={snapshot.hostKey.requestId}
          prompt={snapshot.hostKey}
          onAnswer={(accept) => probe.answerHostKey(accept)}
        />
      )}
      {snapshot.prompt && (
        <CredentialDialog
          key={snapshot.prompt.requestId}
          prompt={snapshot.prompt}
          onAnswer={(answers, remember) => probe.answerPrompt(answers, remember)}
        />
      )}
      {snapshot.hostKeyChanged && (
        <div className="probe-overlay">
          <HostKeyChangedScreen
            key={snapshot.hostKeyChanged.requestId}
            change={snapshot.hostKeyChanged}
            onReplace={() => probe.replaceHostKey()}
            onClose={onClose}
          />
        </div>
      )}
    </>
  );
}
