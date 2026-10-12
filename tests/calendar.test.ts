import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { generateCalendar } from '../src/calendar/generate.js';
import { mergeMatches } from '../src/services/merge.js';
import { type MatchInput, type Schedule } from '../src/models/match.js';

function parseIcs(text: string): string | unknown[] {
  const result: unknown = ICAL.parse(text);
  return result as string | unknown[];
}
const now = '2026-10-12T03:00:00.000Z';
const later = '2026-10-13T03:00:00.000Z';
export function fixture(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    refs: [
      {
        source: 'pfc-cska',
        id: '123',
        url: 'https://pfc-cska.com/ru/matchi/kalendar-matchej/123/',
        priority: 100,
      },
    ],
    home: 'ЦСКА',
    away: 'Спартак М',
    competition: 'РПЛ',
    season: '2026/27',
    round: 'Тур 12',
    venue: 'ВЭБ Арена',
    schedule: { kind: 'timed', date: '2026-10-25', time: '16:00' },
    status: 'scheduled',
    ...overrides,
  };
}
function events(input: MatchInput[]): ICAL.Component[] {
  return new ICAL.Component(
    parseIcs(generateCalendar(mergeMatches([], input, now))),
  ).getAllSubcomponents('vevent');
}
function first(schedule: Schedule): ICAL.Component {
  return events([fixture({ schedule })])[0]!;
}
const time = (event: ICAL.Component, prop: string): ICAL.Time =>
  event.getFirstPropertyValue(prop) as ICAL.Time;

describe('iCalendar semantics (independent ical.js parser)', () => {
  it('exact Moscow kickoff is an absolute UTC instant with 2 hour duration', () => {
    const e = first({ kind: 'timed', date: '2026-10-25', time: '16:00' });
    expect(time(e, 'dtstart').toString()).toBe('2026-10-25T13:00:00Z');
    expect(time(e, 'dtend').toString()).toBe('2026-10-25T15:00:00Z');
    expect(e.getFirstPropertyValue('status')).toBe('CONFIRMED');
  });
  it('a known date without time is a single all-day event', () => {
    const e = first({ kind: 'day', date: '2027-05-29' });
    expect(time(e, 'dtstart').isDate).toBe(true);
    expect(time(e, 'dtend').toString()).toBe('2027-05-30');
  });
  it.each([
    ['2027-02-26', '2027-03-01', '2027-03-02'],
    ['2026-12-30', '2027-01-02', '2027-01-03'],
    ['2028-02-28', '2028-02-29', '2028-03-01'],
  ])(
    'range %s through %s has an exclusive DATE end %s',
    (from, through, exclusive) => {
      const e = first({ kind: 'range', from, through });
      expect(time(e, 'dtstart').toString()).toBe(from);
      expect(time(e, 'dtend').toString()).toBe(exclusive);
      expect(time(e, 'dtend').isDate).toBe(true);
      expect(e.getFirstPropertyValue('status')).toBe('TENTATIVE');
    },
  );
  it('handles historical Moscow UTC+4 rather than applying current UTC+3', () => {
    expect(
      time(
        first({ kind: 'timed', date: '2013-07-01', time: '19:00' }),
        'dtstart',
      ).toString(),
    ).toBe('2013-07-01T15:00:00Z');
  });
  it('includes final score, home-away order, stadium and penalties', () => {
    const e = events([
      fixture({
        home: 'Спартак М',
        away: 'ЦСКА',
        status: 'finished',
        score: '2:1',
        penalties: '5:4',
      }),
    ])[0]!;
    expect(e.getFirstPropertyValue('summary')).toBe('⚽ Спартак М 2:1 ЦСКА');
    expect(e.getFirstPropertyValue('description')).toContain('Пенальти: 5:4');
    expect(e.getFirstPropertyValue('location')).toBe('ВЭБ Арена');
  });
  it('cancelled fixtures remain in the subscription with CANCELLED status', () => {
    expect(
      events([fixture({ status: 'cancelled' })])[0]!.getFirstPropertyValue(
        'status',
      ),
    ).toBe('CANCELLED');
  });
  it('retains DTSTAMP/LAST-MODIFIED, sequence and UID on repeated identical generation', () => {
    const matches = mergeMatches([], [fixture()], now);
    const a = generateCalendar(matches);
    expect(generateCalendar(mergeMatches(matches, [fixture()], later))).toBe(a);
    const e = new ICAL.Component(parseIcs(a)).getFirstSubcomponent('vevent')!;
    expect(time(e, 'dtstamp').toString()).toBe('2026-10-12T03:00:00Z');
    expect(time(e, 'last-modified').toString()).toBe('2026-10-12T03:00:00Z');
    expect(e.getFirstPropertyValue('uid')).toBe(matches[0]!.uid);
    expect(a).toMatch(/\r\n/);
  });
  it('escapes newlines and punctuation and folds long UTF-8 lines safely', () => {
    const name = 'РПЛ, Кубок; \nТурнир '.repeat(15);
    const matches = mergeMatches([], [fixture({ competition: name })], now);
    const out = generateCalendar(matches);
    const e = new ICAL.Component(parseIcs(out)).getFirstSubcomponent('vevent')!;
    expect(e.getFirstPropertyValue('description')).toContain(name);
    for (const line of out.split('\r\n'))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });
  it('does not invent a date for completely undated fixtures', () => {
    const ms = mergeMatches(
      [],
      [
        fixture(),
        fixture({
          refs: [
            {
              source: 'pfc-cska',
              id: '999',
              url: 'https://pfc-cska.com/999/',
              priority: 100,
            },
          ],
          schedule: { kind: 'unknown' },
        }),
      ],
      now,
    );
    expect(ms).toHaveLength(2);
    expect(
      new ICAL.Component(parseIcs(generateCalendar(ms))).getAllSubcomponents(
        'vevent',
      ),
    ).toHaveLength(1);
  });
});

describe('persistent identity and history', () => {
  it.each([
    { schedule: { kind: 'range', from: '2027-02-27', through: '2027-03-02' } },
    { schedule: { kind: 'day', date: '2027-02-28' } },
    { schedule: { kind: 'timed', date: '2027-02-28', time: '19:00' } },
    { schedule: { kind: 'timed', date: '2027-04-01', time: '20:30' } },
    { venue: 'Лужники' },
    { competition: 'Кубок России', round: 'Финал' },
    { status: 'cancelled' },
  ] satisfies Partial<MatchInput>[])(
    'updates %j without changing UID',
    (change) => {
      const old = mergeMatches(
        [],
        [
          fixture({
            schedule: {
              kind: 'range',
              from: '2027-02-26',
              through: '2027-03-01',
            },
          }),
        ],
        now,
      );
      const next = mergeMatches(old, [fixture(change)], later);
      expect(next).toHaveLength(1);
      expect(next[0]!.uid).toBe(old[0]!.uid);
      expect(next[0]!.sequence).toBe(1);
      expect(next[0]!.modified).toBe(later);
      const event = new ICAL.Component(
        parseIcs(generateCalendar(next)),
      ).getFirstSubcomponent('vevent')!;
      expect(event.getFirstPropertyValue('sequence')).toBe(1);
    },
  );
  it('adds kickoff time to an all-day event without duplication', () => {
    const old = mergeMatches(
      [],
      [fixture({ schedule: { kind: 'day', date: '2026-10-25' } })],
      now,
    );
    const next = mergeMatches(old, [fixture()], later);
    expect(next).toHaveLength(1);
    expect(next[0]!.uid).toBe(old[0]!.uid);
    expect(next[0]!.schedule.kind).toBe('timed');
  });
  it('preserves disappeared fixtures and known final results after partial responses', () => {
    const finished = fixture({ score: '2:1', status: 'finished' });
    const old = mergeMatches([], [finished], now);
    const next = mergeMatches(
      old,
      [
        fixture({
          refs: [
            {
              source: 'pfc-cska',
              id: '456',
              url: 'https://pfc-cska.com/456/',
              priority: 100,
            },
          ],
        }),
      ],
      later,
    );
    expect(next).toHaveLength(2);
    expect(next.find((m) => m.uid === old[0]!.uid)!.score).toBe('2:1');
    expect(mergeMatches(old, [fixture()], later)[0]!.score).toBe('2:1');
  });
  it('rejects empty batches', () => {
    expect(() => mergeMatches([], [], now)).toThrow('Empty');
  });
  it('merges sources for an identical round with official information taking priority', () => {
    const secondary = fixture({
      refs: [
        {
          source: 'secondary',
          id: 'xyz',
          url: 'https://example.org/match/xyz',
          priority: 20,
        },
      ],
      schedule: { kind: 'day', date: '2026-10-26' },
      venue: 'Wrong venue',
    });
    const old = mergeMatches([], [secondary], now);
    const next = mergeMatches(old, [fixture()], later);
    expect(next).toHaveLength(1);
    expect(next[0]!.uid).toBe(old[0]!.uid);
    expect(next[0]!.refs).toHaveLength(2);
    expect(next[0]!.venue).toBe('ВЭБ Арена');
    expect(next[0]!.schedule).toEqual(fixture().schedule);
    expect(mergeMatches(next, [secondary], later)[0]!.venue).toBe('ВЭБ Арена');
  });
  it('never conflates distinct IDs, reversed fixtures, stages or seasons', () => {
    const variants: Partial<MatchInput>[] = [
      {},
      { round: 'Тур 27' },
      { home: 'Спартак М', away: 'ЦСКА' },
      { competition: 'Кубок', round: 'Финал' },
      { season: '2025/26' },
    ];
    const items = variants.map((overrides, i) =>
      fixture({
        ...overrides,
        refs: [
          {
            source: 'pfc-cska',
            id: String(i + 1),
            url: `https://pfc-cska.com/${i + 1}`,
            priority: 100,
          },
        ],
      }),
    );
    expect(mergeMatches([], items, now)).toHaveLength(5);
  });
  it('refuses ambiguous cross-source reconciliation', () => {
    const a = fixture({ round: 'Тур 12' }),
      b = fixture({
        refs: [
          {
            source: 'pfc-cska',
            id: '456',
            url: 'https://pfc-cska.com/456',
            priority: 100,
          },
        ],
        round: 'Тур 13',
      });
    const secondary = fixture({
      refs: [
        {
          source: 'other',
          id: '1',
          url: 'https://example.org/1',
          priority: 10,
        },
      ],
    });
    delete secondary.round;
    expect(() =>
      mergeMatches(mergeMatches([], [a, b], now), [secondary], later),
    ).toThrow('Ambiguous');
  });
  it('excludes youth, reserves, legends and non-CSKA teams', () => {
    expect(
      mergeMatches(
        [],
        [
          fixture(),
          fixture({ home: 'ЦСКА-2' }),
          fixture({ home: 'ЦСКА U19' }),
          fixture({ home: 'Молодёжный ЦСКА' }),
          fixture({ home: 'Легенды ЦСКА' }),
          fixture({ home: 'Динамо' }),
        ],
        now,
      ),
    ).toHaveLength(1);
  });
  it('rejects invalid dates, times and reversed ranges', () => {
    for (const schedule of [
      { kind: 'day', date: '2027-02-30' },
      { kind: 'timed', date: '2027-02-28', time: '29:99' },
      { kind: 'range', from: '2027-03-02', through: '2027-03-01' },
    ] as Schedule[])
      expect(() => mergeMatches([], [fixture({ schedule })], now)).toThrow();
  });
});
