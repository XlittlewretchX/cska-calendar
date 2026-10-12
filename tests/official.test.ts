import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverSeasons,
  normalizeOfficial,
  listingSchema,
  rawMatchSchema,
} from '../src/parsers/official.js';
import {
  assertHealthyCount,
  fetchListing,
  collectOfficial,
} from '../src/sources/official.js';
import { emptyDatabase } from '../src/models/match.js';
import { mergeMatches } from '../src/services/merge.js';
import { generateCalendar } from '../src/calendar/generate.js';
import { readDatabase, writeOutputs } from '../src/storage/database.js';
import { HttpClient } from '../src/sources/http.js';

const raw = async (file: string) =>
  listingSchema.parse(
    JSON.parse(
      await readFile(
        new URL(`./fixtures/${file}.json`, import.meta.url),
        'utf8',
      ),
    ),
  );
const html = await readFile(
  new URL('./fixtures/calendar.html', import.meta.url),
  'utf8',
);
const now = '2026-10-12T03:00:00.000Z';

describe('real official snapshots captured 2026-10-12', () => {
  it('discovers all archive seasons and the next winter from Nuxt JSON', () => {
    const seasons = discoverSeasons(html);
    expect(seasons.some((s) => s.name === '1992')).toBe(true);
    expect(seasons.find((s) => s.is_current)?.name).toBe('2026/27');
    expect(seasons.length).toBeGreaterThan(30);
  });
  it('fails if Nuxt payload disappears', () => {
    expect(() => discoverSeasons('<html>maintenance</html>')).toThrow(
      'missing',
    );
  });
  it('preserves the REAL February-March 2027 range, ignoring placeholder kickoff', async () => {
    const rows = await raw('upcoming');
    const normalized = rows.results
      .map(normalizeOfficial)
      .filter((m) => m !== null);
    const match = normalized.find((m) => m.round === 'Тур 18')!;
    expect(match.schedule).toEqual({
      kind: 'range',
      from: '2027-02-26',
      through: '2027-03-01',
    });
    const out = generateCalendar(mergeMatches([], [match], now));
    expect(out).toContain('DTSTART;VALUE=DATE:20270226');
    expect(out).toContain('DTEND;VALUE=DATE:20270302');
    expect(normalized).toHaveLength(23);
    expect(normalized.find((m) => m.round === 'Тур 30')!.schedule).toEqual({
      kind: 'day',
      date: '2027-05-29',
    });
  });
  it('loads finished friendlies and training tournaments without a competition allowlist', async () => {
    const a = (await raw('results')).results
      .map(normalizeOfficial)
      .filter((m) => m !== null);
    const b = (await raw('training')).results
      .map(normalizeOfficial)
      .filter((m) => m !== null);
    expect(a.some((m) => m.competition === 'Товарищеские' && m.score)).toBe(
      true,
    );
    expect(b.some((m) => m.competition === 'Зимний Кубок РПЛ')).toBe(true);
    expect(b.every((m) => m.status === 'finished')).toBe(true);
  });
  it('parses all 1992 matches and rejects malformed records instead of skipping them', async () => {
    const r = await raw('1992');
    expect(r.results.map(normalizeOfficial).filter(Boolean)).toHaveLength(26);
    expect(() => normalizeOfficial({ id: 1 })).toThrow();
  });
  it('does not use placeholder 0:0 for an unfinished fixture', async () => {
    expect(
      normalizeOfficial((await raw('upcoming')).results[0])!.score,
    ).toBeUndefined();
  });
  it('explicitly excludes a youth parent or a different CSKA team ID', async () => {
    const m = rawMatchSchema.parse((await raw('upcoming')).results[0]);
    expect(normalizeOfficial({ ...m, parent: 1234 })).toBeNull();
    expect(
      normalizeOfficial({
        ...m,
        match_team_a: { id: 999, name: 'Молодёжный ЦСКА' },
      }),
    ).toBeNull();
  });
  it('supports explicit cancellation/postponement but does not infer them from missing rows', async () => {
    const m = rawMatchSchema.parse((await raw('upcoming')).results[0]);
    expect(normalizeOfficial({ ...m, match_is_cancelled: true })!.status).toBe(
      'cancelled',
    );
    expect(normalizeOfficial({ ...m, match_status: 'postponed' })!.status).toBe(
      'postponed',
    );
  });
});

describe('complete batches and safe source failure', () => {
  it('follows pagination and sends a literal true archive flag', async () => {
    const rows = (await raw('1992')).results.slice(0, 2);
    const seen: string[] = [];
    const result = await fetchListing(
      (url) => {
        seen.push(url);
        const page = Number(new URL(url).searchParams.get('page'));
        return Promise.resolve(
          JSON.stringify({
            results: [rows[page - 1]],
            total: 2,
            total_pages: 2,
            current_page: page,
            limit: 1,
          }),
        );
      },
      { id: 29551, name: '1992', is_current: false },
      true,
    );
    expect(result).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(new URL(seen[0]!).searchParams.get('is_finished')).toBe('true');
  });
  it('rejects repeated pages, wrong seasons and truncated totals', async () => {
    const source = await raw('1992');
    const season = { id: 29551, name: '1992', is_current: false };
    await expect(
      fetchListing(
        () =>
          Promise.resolve(
            JSON.stringify({ ...source, results: source.results.slice(0, 1) }),
          ),
        season,
        true,
      ),
    ).rejects.toThrow('truncated');
    await expect(
      fetchListing(
        () => Promise.resolve(JSON.stringify(source)),
        { ...season, id: 10 },
        true,
      ),
    ).rejects.toThrow('filters');
    await expect(
      fetchListing(
        () =>
          Promise.resolve(
            JSON.stringify({
              ...source,
              results: source.results.slice(0, 1),
              total_pages: 2,
              total: 2,
            }),
          ),
        season,
        true,
      ),
    ).rejects.toThrow('pagination');
    await expect(
      fetchListing(
        (url) =>
          Promise.resolve(
            JSON.stringify({
              ...source,
              results: source.results.slice(0, 1),
              current_page: Number(new URL(url).searchParams.get('page')),
              total_pages: 2,
              total: 2,
            }),
          ),
        season,
        true,
      ),
    ).rejects.toThrow('Repeated');
  });
  it('rejects empty or suspiciously incomplete known archives', () => {
    expect(() => {
      assertHealthyCount(1, 0, 'archive');
    }).toThrow();
    expect(() => {
      assertHealthyCount(40, 29, 'archive');
    }).toThrow();
    expect(() => {
      assertHealthyCount(40, 40, 'archive');
    }).not.toThrow();
    expect(() => {
      assertHealthyCount(0, 0, 'new empty season');
    }).not.toThrow();
  });
  it('a source outage leaves the entire previous database and calendar byte-for-byte unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cska-test-'));
    try {
      const m = normalizeOfficial((await raw('upcoming')).results[0])!;
      const db = {
        ...emptyDatabase(),
        matches: mergeMatches([], [m], now),
        updatedAt: now,
      };
      const json = `${JSON.stringify(db)}\n`,
        calendar = generateCalendar(db.matches);
      await writeOutputs(root, {
        'data/matches.json': json,
        'public/calendar.ics': calendar,
      });
      await expect(
        collectOfficial(
          () => Promise.reject(new Error('offline')),
          db,
          now,
          false,
        ),
      ).rejects.toThrow('offline');
      expect(await readFile(join(root, 'data/matches.json'), 'utf8')).toBe(
        json,
      );
      expect(await readFile(join(root, 'public/calendar.ics'), 'utf8')).toBe(
        calendar,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects corrupt saved history without replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cska-test-'));
    try {
      await writeOutputs(root, { 'data/matches.json': '{}' });
      await expect(readDatabase(root)).rejects.toThrow();
      expect(await readFile(join(root, 'data/matches.json'), 'utf8')).toBe(
        '{}',
      );
      await writeFile(join(root, 'data/matches.json'), '{ broken');
      await expect(readDatabase(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not retry permanent HTTP errors', async () => {
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response('Not found', { status: 404 }));
    };
    await expect(
      new HttpClient(fetcher, 0).get('https://example.org/'),
    ).rejects.toThrow('404');
    expect(calls).toBe(1);
  });
});
