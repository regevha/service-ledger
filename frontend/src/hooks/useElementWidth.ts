import { useEffect, useState, type RefObject } from 'react';

/** The content width of an element in pixels, kept current as it resizes; `fallback` until it is measured. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width) || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // The element is fixed for the component's life; `fallback` is a constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return width;
}
