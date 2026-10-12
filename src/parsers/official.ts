import { load } from 'cheerio';
import { parse } from 'devalue';
import { z } from 'zod';
import {
  inputSchema,
  isFirstTeam,
  type MatchInput,
  type Schedule,
} from '../models/match.js';

const named = z.object({ id: z.number().int(), name: z.string().min(1) });
const optionalNamed = z.union([named, z.string(), z.null()]).optional();
export const rawMatchSchema = z.object({
  id: z.number().int().positive(),
  parent: z.number().int(),
  url: z.string().min(1),
  match_team_a: named,
  match_team_b: named,
  match_tournament: named,
  match_season: named,
  match_stadium: optionalNamed,
  match_round: optionalNamed,
  match_group: optionalNamed,
  match_datetime: z.string(),
  match_date_not_determined: z.boolean(),
  match_time_not_determined: z.boolean(),
  match_approximate_date_from: z.string().optional(),
  match_approximate_date_to: z.string().optional(),
  match_is_finished: z.boolean(),
  match_score: z.string(),
  match_penalty_score: z.string().optional(),
  match_is_cancelled: z.boolean().optional(),
  match_is_postponed: z.boolean().optional(),
  match_status: z.string().optional(),
});
export const listingSchema = z.object({
  results: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  current_page: z.number().int().positive(),
  limit: z.number().int().nonnegative(),
});
export type RawMatch = z.infer<typeof rawMatchSchema>;
const nameOf = (v: z.infer<typeof optionalNamed>): string | undefined =>
  typeof v === 'object' && v !== null
    ? v.name.replace(/\s+/g, ' ').trim()
    : undefined;

export function normalizeOfficial(value: unknown): MatchInput | null {
  const r = rawMatchSchema.parse(value);
  if (
    r.parent !== 82 ||
    (r.match_team_a.id !== 11630 && r.match_team_b.id !== 11630) ||
    !isFirstTeam(r.match_team_a.name, r.match_team_b.name)
  )
    return null;
  let schedule: Schedule;
  if (r.match_date_not_determined) {
    const from = r.match_approximate_date_from?.slice(0, 10);
    const through = r.match_approximate_date_to?.slice(0, 10);
    // match_datetime is a placeholder when this flag is set. Never invent its day.
    schedule =
      from && through ? { kind: 'range', from, through } : { kind: 'unknown' };
  } else {
    const dt = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(r.match_datetime);
    if (!dt)
      throw new Error(
        `Official match ${r.id}: invalid datetime ${r.match_datetime}`,
      );
    schedule = r.match_time_not_determined
      ? { kind: 'day', date: dt[1]! }
      : { kind: 'timed', date: dt[1]!, time: dt[2]! };
  }
  const round = [nameOf(r.match_group), nameOf(r.match_round)]
    .filter(Boolean)
    .join(', ');
  const status =
    r.match_is_cancelled ||
    /^(cancelled|canceled|отменён|отменен)$/i.test(r.match_status ?? '')
      ? 'cancelled'
      : r.match_is_postponed ||
          /^(postponed|перенесён|перенесен)$/i.test(r.match_status ?? '')
        ? 'postponed'
        : r.match_is_finished
          ? 'finished'
          : 'scheduled';
  const score =
    r.match_is_finished && /^\d+:\d+$/.test(r.match_score)
      ? r.match_score
      : undefined;
  if (r.match_is_finished && !score)
    throw new Error(`Official match ${r.id}: missing final score`);
  const penalties =
    score &&
    r.match_penalty_score &&
    r.match_penalty_score !== '0:0' &&
    /^\d+:\d+$/.test(r.match_penalty_score)
      ? r.match_penalty_score
      : undefined;
  return inputSchema.parse({
    refs: [
      {
        source: 'pfc-cska',
        id: String(r.id),
        url: new URL(r.url, 'https://pfc-cska.com').href,
        priority: 100,
      },
    ],
    home: r.match_team_a.id === 11630 ? 'ЦСКА' : r.match_team_a.name,
    away: r.match_team_b.id === 11630 ? 'ЦСКА' : r.match_team_b.name,
    competition: r.match_tournament.name,
    season: r.match_season.name,
    ...(round ? { round } : {}),
    ...(nameOf(r.match_stadium) ? { venue: nameOf(r.match_stadium) } : {}),
    schedule,
    status,
    ...(score ? { score } : {}),
    ...(penalties ? { penalties } : {}),
  });
}

const seasonsSchema = z
  .array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      is_current: z.boolean(),
    }),
  )
  .min(1);
export type Season = z.infer<typeof seasonsSchema>[number];
export function discoverSeasons(html: string): Season[] {
  const encoded = load(html)('#__NUXT_DATA__').text();
  if (!encoded)
    throw new Error(
      'Official page: __NUXT_DATA__ missing; site structure changed',
    );
  const payload: unknown = parse(encoded, {
    ShallowReactive: (v: unknown) => v,
    Reactive: (v: unknown) => v,
    Ref: (v: unknown) => v,
    ShallowRef: (v: unknown) => v,
  });
  const scan = (v: unknown): Season[] | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    if ('rest_url' in v && v.rest_url === 'listing/matches' && 'seasons' in v)
      return seasonsSchema.parse(v.seasons);
    for (const child of Object.values(v)) {
      const found = scan(child);
      if (found) return found;
    }
    return undefined;
  };
  const seasons = scan(payload);
  if (!seasons || !seasons.some((s) => s.is_current))
    throw new Error(
      'Official page: season catalogue or current season missing',
    );
  if (new Set(seasons.map((s) => s.id)).size !== seasons.length)
    throw new Error('Duplicate seasons');
  return seasons;
}
