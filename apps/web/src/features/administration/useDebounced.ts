import { useEffect, useState } from 'react';

/**
 * Trails a fast-changing value (a search box) so a server-side query is not issued per keystroke.
 * The returned value settles `delay` ms after the last change; typing "paracetamol" costs one
 * request at a shop's network speed rather than eleven.
 */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
