/**
 * Temporal buckets for grouping hints.
 *
 * Collectors hint; the core groups (ADR-0006). A hint needs a coarse time
 * bucket, and every collector needs the same one — two collectors bucketing
 * the same week differently would put a commit and the session that produced
 * it into different groups for no reason a user could ever explain.
 *
 * Shared here rather than copied because the ISO week rule is subtle enough
 * to get wrong twice in two different ways.
 */

const DAY_MS = 86_400_000;

/**
 * ISO-8601 week, as `YYYY-Www`.
 *
 * ISO weeks run Monday to Sunday and belong to the year containing their
 * Thursday, which is why the first days of January can land in the previous
 * year's week 52 or 53.
 */
export function isoWeek(instant: string): string {
  const date = new Date(instant);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const day = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - day + 3);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);

  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
