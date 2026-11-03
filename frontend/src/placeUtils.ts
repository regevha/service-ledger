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

const squash = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/** Equal once case and spaces are ignored, the way the server matches place names. */
export function sameText(a: string, b: string): boolean {
  return squash(a) === squash(b);
}

/**
 * What the institute and room a person has typed refer to: an institute that already exists (or not, so it is new),
 * the rooms known in it, and the room among them. Shared by the instrument form and the intake add-instrument panel,
 * so both say the same thing about the same input.
 */
export function matchTypedPlaces(places: Place[], institute: string, room: string) {
  const matchedInstitution = places.find((p) => p.kind === 'institution' && sameText(p.name, institute));
  const roomsHere = matchedInstitution ? places.filter((p) => p.kind === 'room' && p.institution_id === matchedInstitution.id) : [];
  const matchedRoom = roomsHere.find((p) => sameText(p.name, room));
  return { matchedInstitution, roomsHere, matchedRoom };
}

/** The sentence under the institute and room boxes: whether each is new or already known; null when both are empty. */
export function typedPlaceHint(places: Place[], institute: string, room: string): string | null {
  const hasInstitute = institute.trim() !== '';
  const hasRoom = room.trim() !== '';
  if (!hasInstitute && !hasRoom) return null;
  const { matchedInstitution, matchedRoom } = matchTypedPlaces(places, institute, room);
  const units = (n: number) => `${n} instrument${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (hasInstitute) {
    parts.push(matchedInstitution ? `Existing institute · ${units(matchedInstitution.total_unit_count)}` : 'New institute · it will be added to Places');
  }
  if (hasRoom) {
    parts.push(
      !hasInstitute
        ? 'A room needs an institute: fill in the institute too.'
        : matchedRoom
          ? `Existing room${matchedRoom.faculty_name ? ` in ${matchedRoom.faculty_name}` : ''} · ${units(matchedRoom.total_unit_count)}`
          : 'New room · it will be added to Places'
    );
  }
  return parts.join('. ');
}
