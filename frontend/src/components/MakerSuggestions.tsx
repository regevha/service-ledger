import { useEffect, useState } from 'react';
import { listManufacturers } from '../api';

/**
 * The makers already on file, and their other names, for a manufacturer text box to suggest, so "BD"
 * is picked rather than typed a third way. Only a hint: a maker not in the list can still be typed
 * (it becomes a new maker), and a listed other name is stored as the maker's own name.
 */
export function useMakerNames(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    listManufacturers()
      .then((makers) => current && setNames(makers.flatMap((m) => [m.name, ...m.aliases])))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return names;
}
