import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  inputSchema,
  isFirstTeam,
  type Match,
  type MatchInput,
  type Schedule,
} from '../models/match.js';
const canonical = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^пфк /, '')
    .replace(/^цска москва$/, 'цска');
const priority = (m: MatchInput): number =>
  Math.max(...m.refs.map((r) => r.priority));
const range = (s: Schedule): [string, string] | undefined =>
  s.kind === 'unknown'
    ? undefined
    : s.kind === 'range'
      ? [s.from, s.through]
      : [s.date, s.date];

function sameFixture(a: MatchInput, b: MatchInput): boolean {
  // Two distinct IDs in one source represent distinct matches, even on the same day.
  if (a.refs.some((r) => b.refs.some((s) => r.source === s.source)))
    return false;
  if (
    canonical(a.home) !== canonical(b.home) ||
    canonical(a.away) !== canonical(b.away) ||
    canonical(a.competition) !== canonical(b.competition) ||
    a.season !== b.season
  )
    return false;
  if (a.round && b.round) return canonical(a.round) === canonical(b.round);
  const ar = range(a.schedule),
    br = range(b.schedule);
  if (!ar || !br) return false;
  // Without round/stage evidence only overlapping dates can identify a fixture.
  return ar[0] <= br[1] && br[0] <= ar[1];
}
export function preferredRef(m: MatchInput): MatchInput['refs'][number] {
  return [...m.refs].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.source.localeCompare(b.source) ||
      a.id.localeCompare(b.id),
  )[0]!;
}
export function eventFingerprint(m: MatchInput): string {
  return JSON.stringify({
    home: m.home,
    away: m.away,
    competition: m.competition,
    season: m.season,
    round: m.round,
    venue: m.venue,
    schedule: m.schedule,
    status: m.status,
    score: m.score,
    penalties: m.penalties,
    url: preferredRef(m).url,
  });
}

export function mergeMatches(
  previous: Match[],
  incoming: MatchInput[],
  now: string,
): Match[] {
  if (incoming.length === 0)
    throw new Error('Empty match batch; refusing to update history');
  const result: Match[] = structuredClone(previous);
  // Strong sources first: complementary sources must not override official fields.
  for (const value of [...incoming].sort((a, b) => priority(b) - priority(a))) {
    const item = inputSchema.parse(value);
    if (!isFirstTeam(item.home, item.away)) continue;
    const exact = result.filter((m) =>
      m.refs.some((r) =>
        item.refs.some((s) => r.source === s.source && r.id === s.id),
      ),
    );
    if (exact.length > 1)
      throw new Error('Source identifiers point to different saved fixtures');
    const candidates = exact.length
      ? exact
      : result.filter((m) => sameFixture(m, item));
    if (candidates.length > 1)
      throw new Error(
        `Ambiguous match identity: ${item.home} — ${item.away}. Refusing to guess.`,
      );
    const old = candidates[0];
    if (!old) {
      const ref = preferredRef(item);
      const uid = `${createHash('sha256').update(`${ref.source}:${ref.id}`).digest('hex').slice(0, 32)}@cska-calendar`;
      result.push({ ...item, uid, created: now, modified: now, sequence: 0 });
      continue;
    }
    const stronger = priority(item) >= priority(old);
    const refs = new Map(old.refs.map((r) => [`${r.source}:${r.id}`, r]));
    item.refs.forEach((r) => refs.set(`${r.source}:${r.id}`, r));
    const merged: Match = {
      ...old,
      ...(stronger ? item : {}),
      refs: [...refs.values()].sort(
        (a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
      ),
    };
    // A missing field is not evidence that a known result/location has disappeared.
    if (!merged.venue && item.venue) merged.venue = item.venue;
    if (!merged.round && item.round) merged.round = item.round;
    if (old.score && !item.score) {
      merged.score = old.score;
      merged.status =
        old.status === 'finished' && merged.status === 'scheduled'
          ? 'finished'
          : merged.status;
    }
    if (!merged.score && item.score) {
      merged.score = item.score;
      merged.status = 'finished';
    }
    if (old.penalties && !item.penalties) merged.penalties = old.penalties;
    if (item.schedule.kind === 'unknown' && old.schedule.kind !== 'unknown')
      merged.schedule = old.schedule;
    if (eventFingerprint(merged) !== eventFingerprint(old)) {
      merged.modified = now;
      merged.sequence = old.sequence + 1;
    }
    result[result.indexOf(old)] = merged;
  }
  return result.sort((a, b) => {
    const ad = range(a.schedule)?.[0] ?? '9999',
      bd = range(b.schedule)?.[0] ?? '9999';
    return ad.localeCompare(bd) || a.uid.localeCompare(b.uid);
  });
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === 'unknown') return 'Дата не опубликована';
  if (s.kind === 'range')
    return `Предварительное расписание: ${s.from} — ${s.through} включительно. Точная дата и время будут уточнены.`;
  const date = DateTime.fromISO(s.date).setLocale('ru').toFormat('d LLLL yyyy');
  return s.kind === 'timed'
    ? `${date}, ${s.time} (Москва)`
    : `${date}. Время начала не определено.`;
}
