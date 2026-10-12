import { DateTime } from 'luxon';
import {
  discoverSeasons,
  listingSchema,
  normalizeOfficial,
  rawMatchSchema,
  type Season,
} from '../parsers/official.js';
import {
  type Coverage,
  type Database,
  type MatchInput,
} from '../models/match.js';
import { type GetText } from './http.js';
export const CALENDAR_URL = 'https://pfc-cska.com/ru/matchi/kalendar-matchej/';
export const API_URL = 'https://api.pfc-cska.com/site/listing/matches';

export function assertHealthyCount(
  previous: number,
  current: number,
  scope: string,
): void {
  if (
    (previous > 0 && current === 0) ||
    (previous >= 8 && current < previous * 0.75)
  )
    throw new Error(
      `Suspicious incomplete response (${scope}): ${current}, previously ${previous}. Previous files preserved.`,
    );
}

export async function fetchListing(
  get: GetText,
  season: Season,
  finished: boolean,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const seen = new Set<number>();
  let expectedPages = 1;
  let expectedTotal = -1;
  for (let page = 1; page <= expectedPages; page++) {
    if (page > 100) throw new Error('Official API: unreasonable page count');
    // Boolean must be the literal "true"; "1" is silently ignored by this API.
    // limit=0 is the site's own full-season mode. Follow pagination if it changes.
    const url = new URL(API_URL);
    Object.entries({
      lang: 'ru',
      parent: '82',
      season_id: String(season.id),
      ...(finished ? { is_finished: 'true' } : {}),
      page: String(page),
      limit: '0',
    }).forEach(([k, v]) => {
      url.searchParams.set(k, v);
    });
    const result = listingSchema.parse(JSON.parse(await get(url.href)));
    if (result.current_page !== page)
      throw new Error(`Official API ignored pagination: ${url.href}`);
    if (page === 1) {
      expectedPages = Math.max(result.total_pages, 1);
      expectedTotal = result.total;
    } else if (
      expectedPages !== Math.max(result.total_pages, 1) ||
      expectedTotal !== result.total
    )
      throw new Error('Official API changed during pagination');
    for (const value of result.results) {
      const row = rawMatchSchema.parse(value);
      if (seen.has(row.id))
        throw new Error(`Repeated official match/page: ${row.id}`);
      if (
        finished &&
        (!row.match_is_finished || row.match_season.id !== season.id)
      )
        throw new Error(
          `Official API ignored archive filters for ${season.name}`,
        );
      seen.add(row.id);
      rows.push(value);
    }
    if (result.results.length === 0 && result.total > 0)
      throw new Error('Official API returned an empty page with nonzero total');
  }
  if (rows.length !== expectedTotal)
    throw new Error(
      `Official API truncated ${season.name}: ${rows.length}/${expectedTotal}`,
    );
  return rows;
}

export async function collectOfficial(
  get: GetText,
  db: Database,
  now: string,
  bootstrap: boolean,
): Promise<{ matches: MatchInput[]; coverage: Coverage[] }> {
  const seasons = discoverSeasons(await get(CALENDAR_URL));
  const current = seasons.find((s) => s.is_current)!;
  const all: MatchInput[] = [];
  const add = (rows: unknown[]) => {
    for (const row of rows) {
      const match = normalizeOfficial(row);
      if (match) all.push(match);
    }
  };
  const upcoming = await fetchListing(get, current, false);
  add(upcoming);
  const previousUpcoming = db.matches.filter(
    (m) =>
      m.status === 'scheduled' &&
      m.schedule.kind !== 'unknown' &&
      m.refs.some((r) => r.source === 'pfc-cska') &&
      (m.schedule.kind === 'range' ? m.schedule.through : m.schedule.date) >=
        now.slice(0, 10),
  ).length;
  const futureCount = all.filter((m) => m.status === 'scheduled').length;
  assertHealthyCount(previousUpcoming, futureCount, 'upcoming');
  const coverage = new Map(db.coverage.map((s) => [s.seasonId, s]));
  const recentYear = DateTime.fromISO(now, { zone: 'Europe/Moscow' }).year - 1;
  for (const season of seasons) {
    const cached = coverage.get(season.id);
    const recent = Number(season.name.slice(0, 4)) >= recentYear;
    // Refresh every season at least monthly; recent and newly discovered seasons daily.
    if (
      !bootstrap &&
      cached &&
      !recent &&
      DateTime.fromISO(now).diff(DateTime.fromISO(cached.fetchedAt), 'days')
        .days < 30
    )
      continue;
    const rows = await fetchListing(get, season, true);
    assertHealthyCount(
      cached?.count ?? 0,
      rows.length,
      `archive ${season.name}`,
    );
    add(rows);
    coverage.set(season.id, {
      seasonId: season.id,
      season: season.name,
      count: rows.length,
      fetchedAt: now,
    });
    console.log(`Archive ${season.name}: ${rows.length} matches`);
  }
  if (all.length === 0)
    throw new Error(
      'Official source returned no first-team matches; refusing to overwrite',
    );
  return {
    matches: all,
    coverage: [...coverage.values()].sort((a, b) => a.seasonId - b.seasonId),
  };
}
