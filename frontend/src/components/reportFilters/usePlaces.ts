import { useEffect, useState } from 'react';
import { listPlaces, type Place } from '../../api';

/** Institutes, buildings and rooms to filter by (an empty list hides the control). */
export function usePlaces() {
  const [places, setPlaces] = useState<Place[]>([]);
  useEffect(() => {
    let live = true;
    listPlaces()
      .then((p) => live && setPlaces(p))
      .catch(() => live && setPlaces([]));
    return () => {
      live = false;
    };
  }, []);

  return places;
}
