import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import {
  bucketOf,
  BUCKET_BADGE,
  BUCKET_LABEL,
  type ResultBucket,
} from "@/lib/delivery-stats";
import type { DeliveryResultStatus } from "@mvp/db";
import { fmtJstDateTime } from "@/lib/date-jst";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  caseId?: string;
  bucket?: string;
  from?: string;
  to?: string;
  page?: string;
}>;

const PAGE_SIZE = 50;
const BUCKETS: ResultBucket[] = ["SUCCESS", "FAILED", "REJECTED", "FORM_MISSING"];

export default async function SendLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const caseId = sp.caseId?.trim() || undefined;
  const bucket = sp.bucket?.trim() || undefined;
  const from = sp.from || undefined;
  const to = sp.to || undefined;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const where: Record<string, unknown> = {};
  if (caseId) where["job"] = { caseId };
  if (from || to) {
    where["attemptedAt"] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to + "T23:59:59") } : {}),
    };
  }
  if (bucket) {
    switch (bucket) {
      case "SUCCESS":
        where["status"] = "SUCCESS" as DeliveryResultStatus;
        break;
      case "REJECTED":
        where["status"] = "SKIPPED";
        where["errorType"] = "BLACKLISTED";
        break;
      case "FORM_MISSING":
        where["status"] = "FAILED";
        where["errorType"] = { in: ["FORM_NOT_FOUND", "FIELD_MISMATCH"] };
        break;
      case "FAILED":
        where["status"] = "FAILED";
        where["errorType"] = { notIn: ["FORM_NOT_FOUND", "FIELD_MISMATCH"] };
        break;
    }
  }

  const [total, results, cases, counts] = await Promise.all([
    prisma.deliveryResult.count({ where }),
    prisma.deliveryResult.findMany({
      where,
      orderBy: { attemptedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        job: { include: { case: true, list: true } },
        company: true,
      },
    }),
    prisma.case.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.deliveryResult.groupBy({
      by: ["status", "errorType"],
      _count: true,
    }),
  ]);

  const bucketCounts: Record<ResultBucket, number> = {
    SUCCESS: 0,
    FAILED: 0,
    REJECTED: 0,
    FORM_MISSING: 0,
    CANCELLED: 0,
  };
  for (const c of counts) {
    const b = bucketOf(c.status, c.errorType);
    bucketCounts[b] += c._count;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const exportHref = `/api/send/log/export?${new URLSearchParams(
    Object.fromEntries(
      Object.entries({ caseId, bucket, from, to }).filter(([, v]) => !!v) as [
        string,
        string,
      ][],
    ),
  ).toString()}`;

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "自動送信ログ" }]} />
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold">自動送信ログ (配信結果一覧)</h1>
        <a
          href={exportHref}
          className="px-3 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm"
        >
          CSV エクスポート ↓
        </a>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {BUCKETS.map((b) => (
          <Link
            key={b}
            href={{ query: { ...(caseId ? { caseId } : {}), bucket: b } }}
            className={`rounded border p-3 hover:shadow transition ${
              bucket === b ? "border-[#1e5ab4] ring-1 ring-[#1e5ab4]" : "border-gray-200"
            }`}
          >
            <div className="text-xs text-gray-500">{BUCKET_LABEL[b]}</div>
            <div className="mt-1 text-xl font-semibold">{bucketCounts[b]}</div>
          </Link>
        ))}
      </div>

      <form className="bg-white rounded border border-gray-200 p-4 mb-5 grid grid-cols-1 md:grid-cols-5 gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">案件</label>
          <select
            name="caseId"
            defaultValue={caseId ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">すべて</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">分類</label>
          <select
            name="bucket"
            defaultValue={bucket ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">すべて</option>
            {BUCKETS.map((b) => (
              <option key={b} value={b}>
                {BUCKET_LABEL[b]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">実行日 (開始)</label>
          <input
            name="from"
            type="date"
            defaultValue={from ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">実行日 (終了)</label>
          <input
            name="to"
            type="date"
            defaultValue={to ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
        <div className="flex items-end gap-2">
          <button className="flex-1 px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f]">
            検索
          </button>
          <Link
            href="/send/log"
            className="px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
          >
            クリア
          </Link>
        </div>
      </form>

      <div className="text-xs text-gray-500 mb-2">
        {total} 件中 {(page - 1) * PAGE_SIZE + 1} 〜{" "}
        {Math.min(total, page * PAGE_SIZE)} 件を表示
      </div>

      <div className="bg-white rounded border border-gray-200 overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-36">実行時刻</th>
              <th className="text-left px-3 py-2 font-medium">案件</th>
              <th className="text-left px-3 py-2 font-medium">会社名</th>
              <th className="text-left px-3 py-2 font-medium w-24">分類</th>
              <th className="text-left px-3 py-2 font-medium">エラー</th>
              <th className="text-left px-3 py-2 font-medium w-12">試行</th>
              <th className="px-3 py-2 w-20" />
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  該当する結果がありません。
                </td>
              </tr>
            )}
            {results.map((r) => {
              const b = bucketOf(r.status, r.errorType);
              return (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                    {fmtJstDateTime(r.attemptedAt)}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.job.case.name}</td>
                  <td className="px-3 py-2">{r.company.name}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block text-xs px-2 py-0.5 rounded ${BUCKET_BADGE[b]}`}>
                      {BUCKET_LABEL[b]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 truncate max-w-[260px]">
                    {r.errorType ? (
                      <span title={r.errorMessage ?? ""}>
                        {r.errorType}
                        {r.errorMessage ? ` — ${r.errorMessage.slice(0, 60)}` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.attempts}</td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/send/${r.jobId}`}
                      className="text-[#1e5ab4] text-xs hover:underline"
                    >
                      ジョブへ
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          params={{ caseId, bucket, from, to }}
        />
      )}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  params,
}: {
  page: number;
  totalPages: number;
  params: Record<string, string | undefined>;
}) {
  const makeHref = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    q.set("page", String(p));
    return `/send/log?${q.toString()}`;
  };
  return (
    <div className="flex gap-2 items-center justify-center text-sm">
      <Link
        href={makeHref(Math.max(1, page - 1))}
        className={`px-3 py-1 rounded border ${
          page <= 1 ? "border-gray-200 text-gray-400 pointer-events-none" : "border-gray-300 hover:bg-gray-50"
        }`}
      >
        ←
      </Link>
      <span className="text-gray-600">
        {page} / {totalPages}
      </span>
      <Link
        href={makeHref(Math.min(totalPages, page + 1))}
        className={`px-3 py-1 rounded border ${
          page >= totalPages
            ? "border-gray-200 text-gray-400 pointer-events-none"
            : "border-gray-300 hover:bg-gray-50"
        }`}
      >
        →
      </Link>
    </div>
  );
}
