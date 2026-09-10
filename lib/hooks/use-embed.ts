'use client';

import { useEffect, useState } from 'react';

/** Query parameter a host sets when it frames the app: `?embed=1`. */
export const EMBED_QUERY_PARAM = 'embed';

/**
 * True when the app is running inside a host that owns its own chrome.
 *
 * A host embedding this app in an iframe already renders a language menu and a
 * theme switch of its own, and with `?lang=` and `?theme=` it decides what this
 * app starts with. Leaving our copies of those controls on screen gives the
 * reader two switches for one setting — and the one they reach for first is the
 * one that loses on the next load, because the host reapplies its choice.
 *
 * Resolved after mount rather than during render. The server has no query
 * string to read, so branching on it inline would hydrate differently than it
 * rendered; a first paint that shows the controls and then hides them is the
 * lesser problem and the one React can express.
 *
 * Deliberately narrow. This hides controls a host has taken over — it is not a
 * kiosk mode, and it does not touch Settings (the only route to provider
 * configuration, which a host cannot offer on our behalf) or the project's
 * attribution.
 */
export function useIsEmbedded(): boolean {
  const [embedded, setEmbedded] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- the query string does not
     exist during server render, so this cannot be computed in the initializer
     without hydrating differently than it rendered. use-theme.tsx hydrates from
     localStorage the same way, for the same reason. */
  useEffect(() => {
    setEmbedded(new URLSearchParams(window.location.search).get(EMBED_QUERY_PARAM) === '1');
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return embedded;
}
