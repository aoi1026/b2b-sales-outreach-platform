import type { DeliveryErrorType, DeliveryResultStatus } from "@mvp/db";
import { prisma } from "./db";
import {
  jstDateKey,
  startOfDayJstAgo,
  startOfMonthJst,
  startOfTodayJst,
} from "./date-jst";

/**
 * 配信結果の分類 (SALES STUDIO 成功率仕様)
 *
 * 成功率 (%) = 成功 / (成功 + 失敗) × 100
 *   = 無事に送信完了した件数 / 有効な送信実行件数
 *
 * 「有効な送信実行件数 (= 分母)」に含めるのは SUCCESS と FAILED (送信を試みたが失敗) のみ。
 * 以下は “そもそも送信できなかった / 送らなかった” ため分母から除外する:
 *   - REJECTED     営業拒否 (送信禁止リスト・営業お断り文言を検知しスキップ)
 *   - FORM_MISSING フォームなし (問い合わせフォームを特定できず送信不可)
 *   - UNREACHABLE  送信不可 (URLエラー・タイムアウト等。フォーム到達前に断念=その他エラー)
 *   - CANCELLED    キャンセル / 未送信 (ユーザ中止・未実行・実行中)
 */
export type ResultBucket =
  | "SUCCESS"
  | "FAILED"
  | "UNREACHABLE"
  | "FORM_MISSING"
  | "REJECTED"
  | "CANCELLED";

// 画面・CSV での表示順 (成功 → 分母に入る失敗 → 除外系)
export const BUCKET_ORDER: ResultBucket[] = [
  "SUCCESS",
  "FAILED",
  "UNREACHABLE",
  "FORM_MISSING",
  "REJECTED",
  "CANCELLED",
];

export const BUCKET_LABEL: Record<ResultBucket, string> = {
  SUCCESS: "成功",
  FAILED: "失敗",
  UNREACHABLE: "送信不可",
  FORM_MISSING: "フォームなし",
  REJECTED: "営業拒否",
  CANCELLED: "キャンセル",
};

export const BUCKET_BADGE: Record<ResultBucket, string> = {
  SUCCESS: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  UNREACHABLE: "bg-slate-200 text-slate-600",
  FORM_MISSING: "bg-purple-100 text-purple-700",
  REJECTED: "bg-orange-100 text-orange-700",
  CANCELLED: "bg-gray-200 text-gray-600",
};

// 分母 (有効な送信実行件数) に含まれる分類
export const DENOMINATOR_BUCKETS: ResultBucket[] = ["SUCCESS", "FAILED"];

// 分母から除外する errorType の定義。
//
// 「送信不可」= システムが送信処理を完了させることが物理的・規約的に不可能と判断してスキップ
//   - FORM_NOT_FOUND / FIELD_MISMATCH … フォーム/様式を特定できず入力不可 → 「フォームなし(様式なし)」
//   - NETWORK_ERROR / CAPTCHA_FAILED   … URLエラー・ページなし・reCAPTCHA認証ブロック → 「送信不可(その他エラー)」
//
// 一方「送信エラー」= フォーム入力・送信処理は実行したが失敗 → 分母に【含める】(=「失敗」):
//   TIMEOUT(サーバータイムアウト) / VALIDATION_ERROR(必須漏れ・文字数オーバー) /
//   SUBMIT_FAILED(送信ボタン押下後の失敗) / UNKNOWN(分類不能の送信失敗) / null
const EXCLUDED_FORM_ERRORS: DeliveryErrorType[] = ["FORM_NOT_FOUND", "FIELD_MISMATCH"];
const EXCLUDED_UNREACHABLE_ERRORS: DeliveryErrorType[] = ["NETWORK_ERROR", "CAPTCHA_FAILED"];

export function bucketOf(
  status: DeliveryResultStatus,
  errorType: DeliveryErrorType | null,
): ResultBucket {
  if (status === "SUCCESS") return "SUCCESS";
  if (status === "SKIPPED") return "REJECTED"; // スキップは営業拒否 (BLACKLISTED) のみ
  if (status === "PENDING" || status === "RUNNING") return "CANCELLED";
  // ここから status === "FAILED"
  if (errorType && EXCLUDED_FORM_ERRORS.includes(errorType)) return "FORM_MISSING";
  if (errorType && EXCLUDED_UNREACHABLE_ERRORS.includes(errorType)) return "UNREACHABLE";
  return "FAILED";
}

/**
 * 分類ごとの Prisma where 断片。一覧 / CSV / 集計で同じ定義を使う唯一の真実。
 * bucketOf() と必ず一致させること。
 */
export function bucketWhere(bucket: ResultBucket): Record<string, unknown> {
  switch (bucket) {
    case "SUCCESS":
      return { status: "SUCCESS" };
    case "REJECTED":
      return { status: "SKIPPED" };
    case "FORM_MISSING":
      return { status: "FAILED", errorType: { in: EXCLUDED_FORM_ERRORS } };
    case "UNREACHABLE":
      return { status: "FAILED", errorType: { in: EXCLUDED_UNREACHABLE_ERRORS } };
    case "FAILED":
      // errorType=null の FAILED も bucketOf では「失敗」になるため OR で拾う
      // (Prisma の notIn は null を除外してしまうため明示的に含める)。
      return {
        status: "FAILED",
        OR: [
          { errorType: null },
          { errorType: { notIn: [...EXCLUDED_FORM_ERRORS, ...EXCLUDED_UNREACHABLE_ERRORS] } },
        ],
      };
    case "CANCELLED":
      return { status: { in: ["PENDING", "RUNNING"] } };
  }
}

export type BucketCounts = Record<ResultBucket, number>;

export function emptyBucketCounts(): BucketCounts {
  return {
    SUCCESS: 0,
    FAILED: 0,
    UNREACHABLE: 0,
    FORM_MISSING: 0,
    REJECTED: 0,
    CANCELLED: 0,
  };
}

/**
 * groupBy(["status","errorType"]) の結果を分類別件数へ畳み込む。
 */
export function bucketCountsFrom(
  rows: { status: DeliveryResultStatus; errorType: DeliveryErrorType | null; _count: number }[],
): BucketCounts {
  const counts = emptyBucketCounts();
  for (const r of rows) counts[bucketOf(r.status, r.errorType)] += r._count;
  return counts;
}

export type RateSummary = {
  counts: BucketCounts;
  total: number; // 全分類の合計 (= 送信処理を行った全件)
  validCount: number; // 有効な送信実行件数 (= 分母 = 成功 + 失敗)
  successCount: number; // 成功
  successRate: number | null; // 0-1。分母 0 のとき null
};

export function summarizeRate(counts: BucketCounts): RateSummary {
  const total = BUCKET_ORDER.reduce((s, b) => s + counts[b], 0);
  const validCount = DENOMINATOR_BUCKETS.reduce((s, b) => s + counts[b], 0);
  const successCount = counts.SUCCESS;
  return {
    counts,
    total,
    validCount,
    successCount,
    successRate: validCount > 0 ? successCount / validCount : null,
  };
}

export function formatRatePct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 1000) / 10}%`;
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
      by: ["status", "errorType"],
      where: { attemptedAt: { gte: today } },
      _count: true,
    }),
    prisma.deliveryResult.groupBy({
      by: ["status", "errorType"],
      where: { attemptedAt: { gte: month } },
      _count: true,
    }),
    prisma.case.count({ where: { status: "RUNNING" } }),
    prisma.case.count({ where: { createdAt: { gte: month } } }),
  ]);

  const todaySum = summarizeRate(bucketCountsFrom(todayResults));
  const monthSum = summarizeRate(bucketCountsFrom(monthResults));

  return {
    // 「送信」= 実際に送信処理を行った全件 (分母の有無に関わらず)
    sentToday: todaySum.total,
    successToday: todaySum.successCount,
    failedToday: todaySum.counts.FAILED,
    successRateToday: todaySum.successRate,
    sentThisMonth: monthSum.total,
    successRateThisMonth: monthSum.successRate,
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
