/**
 * JST (Asia/Tokyo, UTC+9) 表示・境界計算ユーティリティ。
 *
 * DB の `timestamp without time zone` カラムは Prisma により UTC 値が格納されているため、
 * 表示時には +9 時間して JST 壁時計表記に変換する。
 *
 * 集計境界 (今日 0:00 JST, 今月 1日0:00 JST 等) も JST で計算する。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC Date を、JST 壁時計表記の "YYYY-MM-DDTHH:MM:SS.sssZ" を表す Date に変換（表示用）。 */
function toJstWall(d: Date): Date {
  return new Date(d.getTime() + JST_OFFSET_MS);
}

/** YYYY-MM-DD (JST) */
export function fmtJstDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return toJstWall(d).toISOString().slice(0, 10);
}

/** YYYY-MM-DD HH:MM (JST) */
export function fmtJstDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return toJstWall(d).toISOString().slice(0, 16).replace("T", " ");
}

/** HH:MM:SS (JST) */
export function fmtJstTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return toJstWall(d).toISOString().slice(11, 19);
}

/** JST における「今日 0:00」を UTC Date として返す。 */
export function startOfTodayJst(): Date {
  const wall = toJstWall(new Date());
  wall.setUTCHours(0, 0, 0, 0);
  return new Date(wall.getTime() - JST_OFFSET_MS);
}

/** JST における「今月 1 日 0:00」を UTC Date として返す。 */
export function startOfMonthJst(): Date {
  const wall = toJstWall(new Date());
  wall.setUTCDate(1);
  wall.setUTCHours(0, 0, 0, 0);
  return new Date(wall.getTime() - JST_OFFSET_MS);
}

/** UTC Date を JST 日付キー (YYYY-MM-DD) に変換 */
export function jstDateKey(d: Date): string {
  return toJstWall(d).toISOString().slice(0, 10);
}

/** JST における「N 日前 0:00」を UTC Date として返す。 */
export function startOfDayJstAgo(daysAgo: number): Date {
  const wall = toJstWall(new Date());
  wall.setUTCDate(wall.getUTCDate() - daysAgo);
  wall.setUTCHours(0, 0, 0, 0);
  return new Date(wall.getTime() - JST_OFFSET_MS);
}
