import type { DeliveryErrorType, DeliveryResultStatus } from "@mvp/db";
import { prisma } from "./db";
import {
  jstDateKey,
  startOfDayJstAgo,
  startOfMonthJst,
  startOfTodayJst,
} from "./date-jst";

/**
 * 配信結果の 5 分類 (xlsx MS2反映 D-3)
 * 成功 / 失敗 / 営業拒否 / フォームなし / キャンセル
 * (キャンセルは DeliveryJob レベル。ここでは DeliveryResult レベルの 4 分類 + extra)
 */
export type ResultBucket = "SUCCESS" | "FAILED" | "REJECTED" | "FORM_MISSING" | "CANCELLED";

export const BUCKET_LABEL: Record<ResultBucket, string> = {
  SUCCESS: "成功",
  FAILED: "失敗",
  REJECTED: "営業拒否",
  FORM_MISSING: "フォームなし",
  CANCELLED: "キャンセル",
};

export const BUCKET_BADGE: Record<ResultBucket, string> = {
  SUCCESS: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  REJECTED: "bg-orange-100 text-orange-700",
  FORM_MISSING: "bg-purple-100 text-purple-700",
  CANCELLED: "bg-gray-200 text-gray-600",
};

export function bucketOf(
  status: DeliveryResultStatus,
  errorType: DeliveryErrorType | null,
): ResultBucket {
  if (status === "SUCCESS") return "SUCCESS";
  if (status === "SKIPPED" && errorType === "BLACKLISTED") return "REJECTED";
  if (status === "FAILED" && (errorType === "FORM_NOT_FOUND" || errorType === "FIELD_MISMATCH"))
    return "FORM_MISSING";
  if (status === "FAILED") return "FAILED";
  // PENDING / RUNNING / SKIPPED (non-BL) — treat as pending/other
  return "FAILED";
}

export type DashboardKpi = {
  sentToday: number;
  successToday: number;
  failedToday: number;
  successRateToday: number | null; // 0-1
  sentThisMonth: number;
  successRateThisMonth: number | null;
  runningCases: number;
  newCasesThisMonth: number;
};

export async function getDashboardKpi(): Promise<DashboardKpi> {
  const today = startOfTodayJst();
  const month = startOfMonthJst();

  const [todayResults, monthResults, running, newCases] = await Promise.all([
    prisma.deliveryResult.groupBy({
      by: ["status"],
      where: { attemptedAt: { gte: today } },
      _count: true,
    }),
    prisma.deliveryResult.groupBy({
      by: ["status"],
      where: { attemptedAt: { gte: month } },
      _count: true,
    }),
    prisma.case.count({ where: { status: "RUNNING" } }),
    prisma.case.count({ where: { createdAt: { gte: month } } }),
  ]);

  const tot = (arr: typeof todayResults) =>
    arr.reduce((s, r) => s + r._count, 0);
  const ok = (arr: typeof todayResults) =>
    arr.find((r) => r.status === "SUCCESS")?._count ?? 0;
  const ng = (arr: typeof todayResults) =>
    arr.find((r) => r.status === "FAILED")?._count ?? 0;

  const sentToday = tot(todayResults);
  const sentThisMonth = tot(monthResults);

  const successToday = ok(todayResults);
  const failedToday = ng(todayResults);

  return {
    sentToday,
    successToday,
    failedToday,
    successRateToday: sentToday > 0 ? successToday / sentToday : null,
    sentThisMonth,
    successRateThisMonth:
      sentThisMonth > 0 ? ok(monthResults) / sentThisMonth : null,
    runningCases: running,
    newCasesThisMonth: newCases,
  };
}

export type DailyPoint = { date: string; success: number; failed: number; skipped: number };

export async function getDailySeries(days = 14): Promise<DailyPoint[]> {
  // JST における (days-1) 日前 0:00 を起点として集計開始
  const from = startOfDayJstAgo(days - 1);

  // attempted_at は timestamp without time zone (UTC 値が格納されている)
  // +9 時間して JST 壁時計化してから日単位 truncate することで JST 日付ごとの集計を得る
  const rows = await prisma.$queryRaw<
    { d: Date; status: DeliveryResultStatus; count: bigint }[]
  >`
    SELECT date_trunc('day', "attempted_at" + interval '9 hours') AS d,
           "status",
           COUNT(*)::bigint AS count
    FROM "delivery_results"
    WHERE "attempted_at" >= ${from}
    GROUP BY d, "status"
    ORDER BY d ASC
  `;

  // 起点 (= JST 0:00) をベースに JST 日付キーを days 個用意
  const map = new Map<string, DailyPoint>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const key = jstDateKey(d);
    map.set(key, { date: key, success: 0, failed: 0, skipped: 0 });
  }

  // PG の date_trunc 結果は "JST 0:00 を表す UTC 同値の timestamp" として返るので
  // toISOString().slice(0, 10) で直接 JST 日付キーが得られる
  for (const r of rows) {
    const key = r.d.toISOString().slice(0, 10);
    const entry = map.get(key);
    if (!entry) continue;
    const n = Number(r.count);
    if (r.status === "SUCCESS") entry.success += n;
    else if (r.status === "FAILED") entry.failed += n;
    else if (r.status === "SKIPPED") entry.skipped += n;
  }
  return Array.from(map.values());
}

export type CasePoint = {
  caseId: string;
  caseName: string;
  success: number;
  failed: number;
  skipped: number;
  total: number;
};

export async function getCaseSeries(
  limit = 8,
  windowDays = 30,
): Promise<CasePoint[]> {
  // 直近 windowDays 日 (JST) に行われた送信結果のみを案件別に集計
  const from = startOfDayJstAgo(windowDays - 1);

  const rows = await prisma.$queryRaw<
    {
      case_id: string;
      case_name: string;
      status: DeliveryResultStatus;
      count: bigint;
    }[]
  >`
    SELECT j."case_id" AS case_id,
           c."name" AS case_name,
           r."status" AS status,
           COUNT(*)::bigint AS count
    FROM "delivery_results" r
    JOIN "delivery_jobs" j ON j."id" = r."job_id"
    JOIN "cases" c ON c."id" = j."case_id"
    WHERE r."attempted_at" >= ${from}
    GROUP BY j."case_id", c."name", r."status"
  `;

  const byCaseId = new Map<string, CasePoint>();
  for (const r of rows) {
    const e = byCaseId.get(r.case_id) ?? {
      caseId: r.case_id,
      caseName: r.case_name,
      success: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    };
    const n = Number(r.count);
    if (r.status === "SUCCESS") e.success += n;
    else if (r.status === "FAILED") e.failed += n;
    else if (r.status === "SKIPPED") e.skipped += n;
    e.total += n;
    byCaseId.set(r.case_id, e);
  }
  return Array.from(byCaseId.values())
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export async function getLatestJobs(limit = 10) {
  return prisma.deliveryJob.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { case: true, list: true },
  });
}
