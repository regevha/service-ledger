import { test, expect } from '@playwright/test';
import { matchTypedPlaces, sameText, typedPlaceHint } from '../../src/placeUtils';
import type { Place } from '../../src/api';

// Pure logic, no browser: the sentence under the institute and room boxes, shared by the instrument form and the
// intake add-instrument panel.

const place = (over: Partial<Place>): Place => ({ id: 'x', kind: 'institution', name: 'X', parent_id: null, institution_id: null, institution_name: null, faculty_name: null, total_unit_count: 0, ...over }) as unknown as Place;

const uni = place({ id: 'u1', kind: 'institution', name: 'Weizmann Institute', institution_id: 'u1', institution_name: 'Weizmann Institute', total_unit_count: 3 });
const bldg = place({ id: 'f1', kind: 'faculty', name: 'Life Sciences Building', parent_id: 'u1', institution_id: 'u1', institution_name: 'Weizmann Institute' });
const roomIn = place({ id: 'r1', kind: 'room', name: 'B12', parent_id: 'f1', institution_id: 'u1', institution_name: 'Weizmann Institute', faculty_name: 'Life Sciences Building', total_unit_count: 1 });
const places = [uni, bldg, roomIn];

test('place text matches ignoring case and extra spaces', () => {
  expect(sameText('  Weizmann   INSTITUTE ', 'weizmann institute')).toBe(true);
  expect(sameText('B12', 'B 12')).toBe(false);
});

test('matchTypedPlaces finds the institute, the rooms in it and the room', () => {
  const hit = matchTypedPlaces(places, 'weizmann institute', 'b12');
  expect(hit.matchedInstitution?.id).toBe('u1');
  expect(hit.roomsHere.map((p) => p.id)).toEqual(['r1']);
  expect(hit.matchedRoom?.id).toBe('r1');
  const miss = matchTypedPlaces(places, 'Elsewhere', 'b12');
  expect(miss.matchedInstitution).toBeUndefined();
  expect(miss.roomsHere).toEqual([]);
  expect(miss.matchedRoom).toBeUndefined();
});

test('typedPlaceHint says what is new and what exists, and counts instruments', () => {
  expect(typedPlaceHint(places, '', '')).toBeNull();
  expect(typedPlaceHint(places, '   ', ' ')).toBeNull();
  expect(typedPlaceHint(places, 'Weizmann Institute', '')).toBe('Existing institute · 3 instruments');
  expect(typedPlaceHint(places, 'Brand New', '')).toBe('New institute · it will be added to Places');
  expect(typedPlaceHint(places, 'Weizmann Institute', 'B12')).toBe('Existing institute · 3 instruments. Existing room in Life Sciences Building · 1 instrument');
  expect(typedPlaceHint(places, 'Weizmann Institute', 'C3')).toBe('Existing institute · 3 instruments. New room · it will be added to Places');
  expect(typedPlaceHint(places, 'Brand New', 'C3')).toBe('New institute · it will be added to Places. New room · it will be added to Places');
  expect(typedPlaceHint(places, '', 'C3')).toBe('A room needs an institute: fill in the institute too.');
});
