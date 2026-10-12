import ical, { ICalEventStatus, ICalEventTransparency } from 'ical-generator';
import { DateTime } from 'luxon';
import { type Match } from '../models/match.js';
import { describeSchedule, preferredRef } from '../services/merge.js';
export const PUBLIC_URL =
  'https://xlittlewretchx.github.io/cska-calendar/calendar.ics';
export function generateCalendar(matches: Match[]): string {
  const cal = ical({
    name: '⚽ ЦСКА — все матчи',
    description:
      'Матчи основной мужской команды ПФК ЦСКА. Расписание, результаты и история.',
    prodId: {
      company: 'CSKA Calendar',
      product: 'cska-calendar',
      language: 'RU',
    },
    url: PUBLIC_URL,
    ttl: 3600,
  });
  // UTC instants avoid depending on the subscriber's zone or incomplete VTIMEZONE.
  // Luxon converts Moscow wall time using historical IANA rules (UTC+4 before 2014).
  for (const match of matches) {
    const s = match.schedule;
    if (s.kind === 'unknown') continue;
    const allDay = s.kind !== 'timed';
    const start =
      s.kind === 'timed'
        ? DateTime.fromISO(`${s.date}T${s.time}`, {
            zone: 'Europe/Moscow',
          }).toUTC()
        : DateTime.fromISO(s.kind === 'range' ? s.from : s.date, {
            zone: 'UTC',
          });
    const end =
      s.kind === 'timed'
        ? start.plus({ hours: 2 })
        : DateTime.fromISO(s.kind === 'range' ? s.through : s.date, {
            zone: 'UTC',
          }).plus({ days: 1 });
    if (!start.isValid || !end.isValid || end <= start)
      throw new Error(`Invalid calendar interval: ${match.uid}`);
    const url = preferredRef(match).url;
    const summary = `⚽ ${match.home} ${match.score ? match.score : '—'} ${match.away}`;
    const description = [
      match.competition,
      `Сезон: ${match.season}`,
      match.round,
      `Хозяева: ${match.home}`,
      `Гости: ${match.away}`,
      match.venue ? `Стадион: ${match.venue}` : undefined,
      describeSchedule(s),
      match.score ? `Итоговый счёт: ${match.score}` : undefined,
      match.penalties ? `Пенальти: ${match.penalties}` : undefined,
      match.status === 'cancelled'
        ? 'Матч отменён.'
        : match.status === 'postponed'
          ? 'Матч перенесён. Следите за уточнениями даты.'
          : undefined,
      s.kind === 'timed'
        ? 'Продолжительность события условная: 2 часа.'
        : undefined,
      url,
    ]
      .filter(Boolean)
      .join('\n');
    cal.createEvent({
      id: match.uid,
      start: start.toJSDate(),
      end: end.toJSDate(),
      allDay,
      stamp: new Date(match.modified),
      created: new Date(match.created),
      lastModified: new Date(match.modified),
      sequence: match.sequence,
      summary,
      description,
      ...(match.venue ? { location: match.venue } : {}),
      url,
      status:
        match.status === 'cancelled'
          ? ICalEventStatus.CANCELLED
          : match.status === 'postponed' || s.kind !== 'timed'
            ? ICalEventStatus.TENTATIVE
            : ICalEventStatus.CONFIRMED,
      transparency: ICalEventTransparency.TRANSPARENT,
    });
  }
  const output = cal.toString();
  if (!output.includes('BEGIN:VEVENT'))
    throw new Error('No dated events; refusing to publish an empty calendar');
  return output;
}
