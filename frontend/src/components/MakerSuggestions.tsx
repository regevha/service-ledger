import { useEffect, useState } from 'react';
import { listManufacturers } from '../api';

/** The id the maker text boxes point their `list` attribute at. */
export const MAKER_LIST_ID = 'maker-names';

/**
 * Suggests the makers already on file while someone types a manufacturer, so "BD" is picked
 * rather than typed a third way. Only a hint: a maker not in the list can still be typed (it
 * becomes a new maker), and a listed other name is stored as the maker's own name.
 */
export function MakerDatalist() {
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
  return (
    <datalist id={MAKER_LIST_ID}>
      {names.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}
