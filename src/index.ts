import { resolve } from 'node:path';
import { databaseSchema, scheduleDate } from './models/match.js';
import { HttpClient } from './sources/http.js';
import { collectOfficial } from './sources/official.js';
import { mergeMatches } from './services/merge.js';
import { generateCalendar } from './calendar/generate.js';
import { readDatabase, writeOutputs } from './storage/database.js';

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const now = new Date().toISOString();
  const previous = await readDatabase(root);
  const http = new HttpClient();
  const fetched = await collectOfficial(
    (url) => http.get(url),
    previous,
    now,
    process.argv.includes('--bootstrap'),
  );
  const matches = mergeMatches(previous.matches, fetched.matches, now);
  const db = databaseSchema.parse({
    schemaVersion: 1,
    matches,
    coverage: fetched.coverage,
    updatedAt: now,
  });
  const calendar = generateCalendar(matches);
  const dated = matches
    .flatMap((m) =>
      scheduleDate(m.schedule) ? [scheduleDate(m.schedule)!] : [],
    )
    .sort();
  const status = {
    updatedAt: now,
    matches: matches.length,
    events: matches.filter((m) => m.schedule.kind !== 'unknown').length,
    period: { from: dated[0], through: dated.at(-1) },
    coverage: fetched.coverage,
    limitations: [
      'Покрытие ограничено опубликованными данными официального API; абсолютная полнота не гарантируется.',
      'Исчезновение встречи не означает её отмену. Отмена требует явного статуса источника.',
      'Матчи без даты и диапазона сохраняются в JSON, но не получают выдуманную дату в календаре.',
    ],
  };
  await writeOutputs(root, {
    'data/matches.json': `${JSON.stringify(db, null, 2)}\n`,
    'public/calendar.ics': calendar,
    'public/status.json': `${JSON.stringify(status, null, 2)}\n`,
  });
  console.log(
    `Saved ${matches.length} matches, ${status.events} events, ${dated[0]} — ${dated.at(-1)}. Undated: ${matches.length - status.events}.`,
  );
}
main().catch((error: unknown) => {
  console.error('Update failed; previous calendar preserved:', error);
  process.exitCode = 1;
});
