import { z } from 'zod';
import { DateTime } from 'luxon';

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => DateTime.fromISO(s).isValid, 'Invalid calendar date');
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('timed'),
    date: dateSchema,
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }),
  z.object({ kind: z.literal('day'), date: dateSchema }),
  z
    .object({ kind: z.literal('range'), from: dateSchema, through: dateSchema })
    .refine(
      (s) =>
        s.from <= s.through &&
        DateTime.fromISO(s.through).diff(DateTime.fromISO(s.from), 'days')
          .days <= 60,
      'Invalid preliminary range',
    ),
  z.object({ kind: z.literal('unknown') }),
]);
export const refSchema = z.object({
  source: z.string().min(1),
  id: z.string().min(1),
  url: z.url(),
  priority: z.number().int().nonnegative(),
});
export const inputSchema = z.object({
  refs: z.array(refSchema).min(1),
  home: z.string().min(1),
  away: z.string().min(1),
  competition: z.string().min(1),
  season: z.string().min(1),
  round: z.string().optional(),
  venue: z.string().optional(),
  schedule: scheduleSchema,
  status: z.enum(['scheduled', 'finished', 'postponed', 'cancelled']),
  score: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional(),
  penalties: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional(),
});
export const matchSchema = inputSchema.extend({
  uid: z.string().min(1),
  created: z.iso.datetime(),
  modified: z.iso.datetime(),
  sequence: z.number().int().nonnegative(),
});
export const coverageSchema = z.object({
  seasonId: z.number().int(),
  season: z.string(),
  count: z.number().int().nonnegative(),
  fetchedAt: z.iso.datetime(),
});
export const databaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    matches: z.array(matchSchema),
    coverage: z.array(coverageSchema),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((db, ctx) => {
    const uids = db.matches.map((m) => m.uid);
    const refs = db.matches.flatMap((m) =>
      m.refs.map((r) => `${r.source}:${r.id}`),
    );
    if (
      new Set(uids).size !== uids.length ||
      new Set(refs).size !== refs.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate UID or source match identifier',
      });
  });
export type Schedule = z.infer<typeof scheduleSchema>;
export type MatchInput = z.infer<typeof inputSchema>;
export type Match = z.infer<typeof matchSchema>;
export type Database = z.infer<typeof databaseSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export const scheduleDate = (s: Schedule): string | undefined =>
  s.kind === 'range' ? s.from : s.kind === 'unknown' ? undefined : s.date;
export const emptyDatabase = (): Database => ({
  schemaVersion: 1,
  matches: [],
  coverage: [],
  updatedAt: new Date(0).toISOString(),
});
export function isFirstTeam(home: string, away: string): boolean {
  const names = [home, away].map((s) =>
    s.toLowerCase().replace(/\s+/g, ' ').trim(),
  );
  // The CSKA side must be the first team. An opponent may itself be a youth
  // or reserve side; that does not make a first-team friendly ineligible.
  return names.some((s) => /^(?:пфк )?цска(?: москва)?$/.test(s));
}
