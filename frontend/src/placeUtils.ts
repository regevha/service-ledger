import type { Place } from './api';

/** A place with the path above it, so rooms of different institutions can be told apart. */
export function placeLabel(p: Place): string {
  if (p.kind === 'institution') return p.name;
  const parts = [p.institution_name];
  if (p.kind === 'room' && p.faculty_name) parts.push(p.faculty_name);
  parts.push(p.name);
  return parts.join(' › ');
}

/** The place's id and the ids of every place inside it; null when no place is chosen. */
export function idsInside(places: Place[], id: string | undefined): Set<string> | null {
  if (!id) return null;
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of places) {
      if (p.parent_id && ids.has(p.parent_id) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return ids;
}
