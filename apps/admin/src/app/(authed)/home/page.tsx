import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import {
  getDashboardKpi,
  getDailySeries,
  getCaseSeries,
  getLatestJobs,
} from "@/lib/delivery-stats";
import {
  JOB_STATUS_BADGE,
  JOB_STATUS_LABEL,
} from "@/lib/delivery-status";
import { fmtJstDateTime } from "@/lib/date-jst";
import DailyBar from "@/components/charts/DailyBar";
import CaseBar from "@/components/charts/CaseBar";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [kpi, daily, cases, latestJobs] = await Promise.all([
    getDashboardKpi(),
    getDailySeries(14),
    getCaseSeries(8),
    getLatestJobs(10),
  ]);

  const successRatePct = (v: number | null) =>
    v == null ? "—" : `${Math.round(v * 1000) / 10}%`;

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "ホーム" }]} />
      <h1 className="text-2xl font-bold mb-6">ダッシュボード</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard title="本日送信" value={kpi.sentToday} suffix="件" />
        <KpiCard
          title="本日成功率"
          value={successRatePct(kpi.successRateToday)}
          hint={`成功 ${kpi.successToday} / 失敗 ${kpi.failedToday}`}
          accent="green"
        />
        <KpiCard title="今月送信" value={kpi.sentThisMonth} suffix="件" />
        <KpiCard
          title="今月成功率"
          value={successRatePct(kpi.successRateThisMonth)}
          accent="green"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <KpiCard title="進行中の案件" value={kpi.runningCases} suffix="件" />
        <KpiCard title="今月新規案件" value={kpi.newCasesThisMonth} suffix="件" />
        <div className="md:col-span-2 bg-white border border-gray-200 rounded p-4">
          <h3 className="text-sm font-semibold text-gray-600 mb-2">サマリー操作</h3>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/cases/new"
              className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-xs"
            >
              ＋ 新規案件
            </Link>
            <Link
              href="/send/new"
              className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-xs"
            >
              ＋ 新規送信ジョブ
            </Link>
            <Link
              href="/lists/import"
              className="px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 text-xs"
            >
              リスト取込
            </Link>
            <Link
              href="/send/log"
              className="px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 text-xs"
            >
              配信結果一覧
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <section className="bg-white border border-gray-200 rounded p-5">
          <h2 className="text-sm font-semibold text-gray-600 mb-3">
            ■ 日次送信結果 (直近 14 日)
          </h2>
          <DailyBar data={daily} />
        </section>
        <section className="bg-white border border-gray-200 rounded p-5">
          <h2 className="text-sm font-semibold text-gray-600 mb-3">
            ■ 案件別送信実績 (直近 30 日 / 上位 8 案件)
          </h2>
          {cases.length === 0 ? (
            <div className="h-[240px] flex items-center justify-center text-sm text-gray-400">
              送信データがまだありません
            </div>
          ) : (
            <CaseBar data={cases} />
          )}
        </section>
      </div>

      <section className="bg-white border border-gray-200 rounded overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-600 flex items-center justify-between">
          <span>■ 最新ジョブログ (直近 10 件)</span>
          <Link href="/send" className="text-xs text-[#1e5ab4] hover:underline font-normal">
            すべて見る →
          </Link>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">ジョブ</th>
              <th className="text-left px-3 py-2 font-medium">案件</th>
              <th className="text-left px-3 py-2 font-medium">リスト</th>
              <th className="text-left px-3 py-2 font-medium w-24">状態</th>
              <th className="text-left px-3 py-2 font-medium w-40">進捗</th>
              <th className="text-left px-3 py-2 font-medium w-36">作成</th>
            </tr>
          </thead>
          <tbody>
            {latestJobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  送信ジョブがまだありません。
                </td>
              </tr>
            )}
            {latestJobs.map((j) => {
              const processed = j.successCount + j.failedCount + j.skippedCount;
              return (
                <tr key={j.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/send/${j.id}`} className="hover:text-[#1e5ab4]">
                      {j.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{j.case.name}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{j.list.name}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block text-xs px-2 py-0.5 rounded ${JOB_STATUS_BADGE[j.status]}`}
                    >
                      {JOB_STATUS_LABEL[j.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {processed} / {j.plannedCount}
                    <span className="ml-1 text-[10px] text-gray-400">
                      (成功 {j.successCount} / 失敗 {j.failedCount} / スキップ {j.skippedCount})
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                    {fmtJstDateTime(j.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function KpiCard({
  title,
  value,
  suffix,
  hint,
  accent,
}: {
  title: string;
  value: number | string;
  suffix?: string;
  hint?: string;
  accent?: "green" | "red";
}) {
  const color =
    accent === "green" ? "text-green-700" : accent === "red" ? "text-red-700" : "";
  return (
    <div className="rounded border bg-white border-gray-200 p-4">
      <div className="text-xs text-gray-600 mb-2">{title}</div>
      <div className="flex items-end gap-2">
        <div className={`text-2xl font-bold tracking-tight ${color}`}>{value}</div>
        {suffix && <div className="pb-0.5 text-xs text-gray-500">{suffix}</div>}
      </div>
      {hint && <div className="mt-1 text-[11px] text-gray-500">{hint}</div>}
    </div>
  );
}
