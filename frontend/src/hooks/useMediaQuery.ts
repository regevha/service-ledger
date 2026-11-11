import { useEffect, useState } from 'react';

/** True while the window matches a CSS media query (e.g. '(min-width: 1100px)'); follows resizes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** The width at and below which the app uses its phone layout (the same breakpoint the stylesheets use). */
export const PHONE_QUERY = '(max-width: 620px)';
