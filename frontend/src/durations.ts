/**
 * Clock durations printed as HH:MM, with their value in decimal hours, so a
 * reviewer sees "01:25 = 1.42 h" next to what the extraction will use. Only
 * unambiguous cases are picked up: the last time in a table row that holds
 * three or more times (from, to, total), or the only time on a line that talks
 * about total, duration or hours. A bare time of day is not a duration.
 */
export function findDurations(text: string): { printed: string; hours: number }[] {
  const found: { printed: string; hours: number }[] = [];
  for (const line of text.split('\n')) {
    const times = [...line.matchAll(/(?<!\d)(\d{1,2}):([0-5]\d)(?!\d)/g)];
    if (times.length === 0) continue;
    let pick: RegExpMatchArray | undefined;
    if (times.length >= 3) pick = times[times.length - 1];
    else if (times.length === 1 && /total|duration|hours/i.test(line)) pick = times[0];
    if (!pick) continue;
    const hours = Number(pick[1]) + Number(pick[2]) / 60;
    found.push({ printed: pick[0], hours: Math.round(hours * 100) / 100 });
  }
  return found;
}
