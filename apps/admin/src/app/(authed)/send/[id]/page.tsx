import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import {
  JOB_STATUS_BADGE,
  JOB_STATUS_LABEL,
  RESULT_STATUS_BADGE,
  RESULT_STATUS_LABEL,
} from "@/lib/delivery-status";
import { pauseJobAction, resumeJobAction, cancelJobAction } from "../actions";
import AutoRefresh from "./AutoRefresh";
import { fmtJstDateTime, fmtJstTime } from "@/lib/date-jst";

export const dynamic = "force-dynamic";

export default async function SendJobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await prisma.deliveryJob.findUnique({
    where: { id },
    include: {
      case: true,
      list: true,
      messageTemplate: true,
      senderTemplate: true,
      results: {
        include: { company: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!job) notFound();

  const processed = job.successCount + job.failedCount + job.skippedCount;
  const progressPct =
    job.plannedCount > 0 ? Math.round((processed / job.plannedCount) * 100) : 0;
  const isActive = job.status === "PENDING" || job.status === "RUNNING";
  const canPause = job.status === "RUNNING" && !job.pauseRequested;
  const canResume = job.status === "PAUSED";
  const canCancel = isActive || job.status === "PAUSED";

  const pause = pauseJobAction.bind(null, id);
  const resume = resumeJobAction.bind(null, id);
  const cancel = cancelJobAction.bind(null, id);

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "自動送信", href: "/send" },
          { label: `ジョブ ${id.slice(0, 8)}` },
        ]}
      />

      <AutoRefresh enabled={isActive || job.status === "PAUSED"} />

      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold">送信ジョブ詳細</h1>
          <div className="mt-1 text-sm text-gray-500 flex items-center gap-3">
            <span className={`inline-block text-xs px-2 py-0.5 rounded ${JOB_STATUS_BADGE[job.status]}`}>
              {JOB_STATUS_LABEL[job.status]}
            </span>
            <span className="font-mono text-xs">{job.id}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canPause && (
            <form action={pause}>
              <button className="px-3 py-1.5 border border-yellow-400 text-yellow-800 rounded hover:bg-yellow-50 text-sm">
                一時停止
              </button>
            </form>
          )}
          {canResume && (
            <form action={resume}>
              <button className="px-3 py-1.5 border border-blue-400 text-blue-800 rounded hover:bg-blue-50 text-sm">
                再開
              </button>
            </form>
          )}
          {canCancel && (
            <form action={cancel}>
              <button className="px-3 py-1.5 border border-red-400 text-red-700 rounded hover:bg-red-50 text-sm">
                キャンセル
              </button>
            </form>
          )}
        </div>
      </div>

      <section className="bg-white border border-gray-200 rounded p-5 mb-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ ジョブ構成</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <dt className="text-gray-500">案件</dt>
          <dd>
            <Link href={`/cases/${job.caseId}`} className="hover:text-[#1e5ab4]">
              {job.case.name}
            </Link>
          </dd>
          <dt className="text-gray-500">リスト</dt>
          <dd>
            <Link href={`/lists/${job.listId}`} className="hover:text-[#1e5ab4]">
              {job.list.name}
            </Link>
          </dd>
          <dt className="text-gray-500">送信文章</dt>
          <dd>
            <Link
              href={`/templates/message/${job.messageTemplateId}`}
              className="hover:text-[#1e5ab4]"
            >
              {job.messageTemplate.name}
            </Link>
          </dd>
          <dt className="text-gray-500">送信元</dt>
          <dd>
            {job.senderTemplate ? (
              <Link
                href={`/templates/sender/${job.senderTemplate.id}`}
                className="hover:text-[#1e5ab4]"
              >
                {job.senderTemplate.name} ({job.senderTemplate.personName})
              </Link>
            ) : (
              <span className="text-gray-400">（指定なし）</span>
            )}
          </dd>
          <dt className="text-gray-500">メモ</dt>
          <dd>{job.note ?? "—"}</dd>
          <dt className="text-gray-500">作成 / 開始 / 完了 (JST)</dt>
          <dd className="text-xs text-gray-600">
            {fmtJstDateTime(job.createdAt)} / {fmtJstDateTime(job.startedAt)} /{" "}
            {fmtJstDateTime(job.completedAt)}
          </dd>
        </dl>
      </section>

      <section className="bg-white border border-gray-200 rounded p-5 mb-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ 進捗</h2>
        <div className="flex gap-4 mb-3 text-sm">
          <Stat label="計画" value={job.plannedCount} />
          <Stat label="成功" value={job.successCount} color="text-green-700" />
          <Stat label="失敗" value={job.failedCount} color="text-red-700" />
          <Stat label="スキップ" value={job.skippedCount} color="text-gray-600" />
          <Stat label="処理済" value={processed} />
        </div>
        <div className="w-full bg-gray-200 rounded h-3 overflow-hidden">
          <div
            className="bg-[#1e5ab4] h-3 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="mt-1 text-xs text-gray-500 text-right">{progressPct}%</div>
      </section>

      <section className="bg-white border border-gray-200 rounded overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-600 flex items-center justify-between">
          <span>■ 送信結果 ({job.results.length} 件)</span>
          <a
            href="http://localhost:3001/dummy-log"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-[#1e5ab4] hover:underline font-normal"
          >
            ダミーフォーム受信ログを開く (dev) ↗
          </a>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">会社名</th>
              <th className="text-left px-3 py-2 font-medium">フォームURL</th>
              <th className="text-left px-3 py-2 font-medium w-20">状態</th>
              <th className="text-left px-3 py-2 font-medium">エラー</th>
              <th className="text-left px-3 py-2 font-medium w-16">試行</th>
              <th className="text-left px-3 py-2 font-medium w-32">実行時刻</th>
            </tr>
          </thead>
          <tbody>
            {job.results.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2">{r.company.name}</td>
                <td className="px-3 py-2 text-xs text-gray-600 truncate max-w-[240px]">
                  <a href={r.company.formUrl} target="_blank" rel="noreferrer" className="hover:underline">
                    {r.company.formUrl}
                  </a>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded ${RESULT_STATUS_BADGE[r.status]}`}>
                    {RESULT_STATUS_LABEL[r.status]}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-gray-600 truncate max-w-[200px]">
                  {r.errorType ? (
                    <span title={r.errorMessage ?? ""}>
                      {r.errorType} {r.errorMessage ? `— ${r.errorMessage.slice(0, 50)}` : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.attempts}</td>
                <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                  {fmtJstTime(r.attemptedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${color ?? ""}`}>{value}</div>
    </div>
  );
}
