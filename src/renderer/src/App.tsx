import { useCallback, useEffect, useRef, useState } from 'react';
import type { Auth } from '../../shared/ipc.js';
import { QuickConnect } from './components/QuickConnect.js';
import { TerminalScreen } from './components/TerminalScreen.js';
import { SessionEvents, TerminalSession, type Target } from './terminal/connection.js';

const api = window.quqa;
const events = new SessionEvents(api);

export function App() {
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [lastTarget, setLastTarget] = useState<Partial<Target>>({});
  const pendingAuth = useRef<Auth | null>(null);

  const takeAuth = useCallback(() => {
    const auth = pendingAuth.current;
    pendingAuth.current = null;
    return auth;
  }, []);

  useEffect(() => {
    if (!api.testHooks) return;
    window.__quqaTest = {
      text: () => session?.text() ?? '',
      state: () => session?.getSnapshot().state ?? 'none',
      renderer: () => session?.getSnapshot().renderer ?? 'none',
    };
  }, [session]);

  if (!session) {
    return (
      <QuickConnect
        initial={lastTarget}
        error={null}
        onConnect={(target, auth) => {
          pendingAuth.current = auth;
          setLastTarget(target);
          setSession(new TerminalSession(api, events, target));
        }}
      />
    );
  }

  return (
    <TerminalScreen
      session={session}
      takeAuth={takeAuth}
      onClose={() => {
        session.dispose();
        setSession(null);
      }}
    />
  );
}
