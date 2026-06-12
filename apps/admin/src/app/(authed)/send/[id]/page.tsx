import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { JOB_STATUS_BADGE, JOB_STATUS_LABEL } from "@/lib/delivery-status";
import {
  bucketOf,
  emptyBucketCounts,
  summarizeRate,
  formatRatePct,
  BUCKET_ORDER,
  BUCKET_LABEL,
  BUCKET_BADGE,
  type ResultBucket,
} from "@/lib/delivery-stats";
import {
  pauseJobAction,
  resumeJobAction,
  cancelJobAction,
  updateJobNoteAction,
  toggleResultManualSentAction,
  updateResultNoteAction,
} from "../actions";
import DeleteJobButton from "../DeleteJobButton";
import AutoRefresh from "./AutoRefresh";
import { fmtJstDateTime, fmtJstTime } from "@/lib/date-jst";

export const dynamic = "force-dynamic";

export default async function SendJobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; rb?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const rbSet = new Set(
    (Array.isArray(sp.rb) ? sp.rb : sp.rb ? [sp.rb] : []).filter((b) =>
      (BUCKET_ORDER as string[]).includes(b),
    ) as ResultBucket[],
  );
  const job = await prisma.deliveryJob.findUnique({
    where: { id },
    include: {
      case: true,
      list: true,
      messageTemplate: true,
      fallbackMessageTemplate: true,
      senderTemplate: true,
      results: {
        // screenshot (PNG bytes) は重いので一覧クエリでは取得しない。
        // 実体は /api/send/screenshot/[id] 経由で個別に配信する。
        omit: { screenshot: true },
        include: { company: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!job) notFound();

  // スクリーンショットを保持している結果の id 集合 (バイト列は読まずに存在判定のみ)
  const withShot = await prisma.deliveryResult.findMany({
    where: { jobId: id, screenshot: { not: null } },
    select: { id: true },
  });
  const shotIds = new Set(withShot.map((r) => r.id));

  const processed = job.successCount + job.failedCount + job.skippedCount;
  const progressPct =
    job.plannedCount > 0 ? Math.round((processed / job.plannedCount) * 100) : 0;

  // 送信結果を分類し成功率を算出 (成功率 = 成功 ÷ (成功 + 失敗))
  const jobBuckets = emptyBucketCounts();
  for (const r of job.results) jobBuckets[bucketOf(r.status, r.errorType)]++;
  const jobSummary = summarizeRate(jobBuckets);

  // 送信元 (送信内容) の表示用整形
  const st = job.senderTemplate;
  const senderFullName = st
    ? [st.familyName, st.givenName].filter(Boolean).join(" ")
    : "";
  const senderAddress = st
    ? [st.prefecture, st.city, st.addressLine, st.building]
        .map((p) => p?.trim())
        .filter(Boolean)
        .join("") || st.address
    : null;

  // 会社別の結果フィルタ (会社名 or フォームURL 部分一致 + 分類チェックボックス)
  const qLower = q.toLowerCase();
  const filteredResults = job.results.filter((r) => {
    if (rbSet.size > 0 && !rbSet.has(bucketOf(r.status, r.errorType))) return false;
    if (q && !(`${r.company.name} ${r.company.formUrl}`.toLowerCase().includes(qLower)))
      return false;
    return true;
  });

  // CSV ダウンロード URL (現在のフィルタを引き継ぐ)
  const exportParams = new URLSearchParams();
  exportParams.set("jobId", id);
  if (q) exportParams.set("q", q);
  for (const b of rbSet) exportParams.append("rb", b);
  const exportHref = `/api/send/log/export?${exportParams.toString()}`;

  // URL クリック計測 (trackUrlClicks 有効時): クリックした企業の割合 = クリック>0 / 成功
  const clickedCompanies = job.results.filter((r) => r.urlClicks > 0).length;
  const clickRate =
    jobSummary.successCount > 0 ? clickedCompanies / jobSummary.successCount : null;

  const isActive = job.status === "PENDING" || job.status === "RUNNING";
  const canPause = job.status === "RUNNING" && !job.pauseRequested;
  const canResume = job.status === "PAUSED";
  const canCancel = isActive || job.status === "PAUSED";
  const canDelete = job.status !== "RUNNING";

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
          {canDelete && (
            <DeleteJobButton
              jobId={id}
              redirectTo="/send"
              className="px-3 py-1.5 border border-red-400 text-red-700 rounded hover:bg-red-50 text-sm"
            />
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
          <dt className="text-gray-500">短文フォールバック</dt>
          <dd>
            {job.fallbackMessageTemplate ? (
              <Link
                href={`/templates/message/${job.fallbackMessageTemplate.id}`}
                className="hover:text-[#1e5ab4]"
              >
                {job.fallbackMessageTemplate.name}
              </Link>
            ) : (
              <span className="text-gray-400">（なし）</span>
            )}
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

      {job.senderTemplate && (
        <section className="bg-white border border-gray-200 rounded overflow-hidden mb-5">
          <div className="px-5 py-2.5 bg-gray-800 text-white text-sm font-semibold">送信内容</div>
          <dl className="text-sm">
            <SenderRow label="担当者" highlight>
              <Link
                href={`/templates/sender/${job.senderTemplate.id}`}
                className="text-[#1e5ab4] hover:underline"
              >
                {job.senderTemplate.personName || senderFullName} ✎
              </Link>
            </SenderRow>
            <SenderRow label="会社名">{job.senderTemplate.companyName}</SenderRow>
            <SenderRow label="郵便番号" highlight>{job.senderTemplate.postalCode ?? "—"}</SenderRow>
            <SenderRow label="住所">{senderAddress ?? "—"}</SenderRow>
            <SenderRow label="部署" highlight>{job.senderTemplate.department ?? "—"}</SenderRow>
            <SenderRow label="役職">{job.senderTemplate.position ?? "—"}</SenderRow>
            <SenderRow label="姓 (カナ)" highlight>{job.senderTemplate.familyNameKana ?? "—"}</SenderRow>
            <SenderRow label="名 (カナ)">{job.senderTemplate.givenNameKana ?? "—"}</SenderRow>
            <SenderRow label="メールアドレス" highlight>{job.senderTemplate.email}</SenderRow>
            <SenderRow label="電話番号">{job.senderTemplate.phone ?? "—"}</SenderRow>
          </dl>
        </section>
      )}

      <section className="bg-white border border-gray-200 rounded p-5 mb-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ 進捗・送信成功率</h2>

        <div className="flex flex-col md:flex-row md:items-center gap-6 mb-4">
          <div>
            <div className="text-xs text-gray-500 mb-1">送信成功率</div>
            <div className="text-3xl font-bold tracking-tight text-green-700">
              {formatRatePct(jobSummary.successRate)}
            </div>
            <div className="text-[11px] text-gray-500 mt-1">
              成功 {jobSummary.successCount} ／ 有効送信 {jobSummary.validCount}（成功＋失敗）
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {BUCKET_ORDER.map((b) => (
              <span
                key={b}
                className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded ${BUCKET_BADGE[b]}`}
              >
                {BUCKET_LABEL[b]}
                <span className="font-semibold">{jobBuckets[b]}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="flex gap-6 mb-3 text-sm">
          <Stat label="計画" value={job.plannedCount} />
          <Stat label="処理済" value={processed} />
        </div>
        <div className="w-full bg-gray-200 rounded h-3 overflow-hidden">
          <div
            className="bg-[#1e5ab4] h-3 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="mt-1 text-xs text-gray-500 text-right">進捗 {progressPct}%</div>
        <p className="mt-2 text-[11px] text-gray-400">
          成功率 ＝ 成功 ÷（成功 ＋ 失敗）×100。営業拒否・フォームなし・送信不可・キャンセルは分母から除外。
        </p>
      </section>

      {job.trackUrlClicks && (
        <section className="bg-white border border-gray-200 rounded overflow-hidden mb-5">
          <div className="px-5 py-2.5 bg-gray-800 text-white text-sm font-semibold">
            URLアクセス記録
          </div>
          <div className="p-5">
            <div className="text-xs text-gray-500 mb-1">クリックした企業の割合</div>
            <div className="flex items-end gap-2 mb-2">
              <div className="text-3xl font-bold text-green-700">
                {clickRate == null ? "—" : `${Math.round(clickRate * 100)}%`}
              </div>
              <div className="text-xs text-gray-500 pb-1">
                {clickedCompanies}/{jobSummary.successCount}
              </div>
            </div>
            <div className="w-full bg-gray-200 rounded h-3 overflow-hidden">
              <div
                className="bg-green-500 h-3"
                style={{ width: `${clickRate == null ? 0 : Math.round(clickRate * 100)}%` }}
              />
            </div>
          </div>
        </section>
      )}

      {/* 備考 (ジョブ単位・編集可) */}
      <section className="bg-white border border-gray-200 rounded p-5 mb-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-2">■ 備考</h2>
        <form action={updateJobNoteAction.bind(null, id)} className="flex items-start gap-3">
          <textarea
            name="note"
            defaultValue={job.note ?? ""}
            maxLength={300}
            rows={2}
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm"
            placeholder="このジョブのメモ"
          />
          <button className="px-4 py-2 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm whitespace-nowrap">
            保存
          </button>
        </form>
      </section>

      <section className="bg-white border border-gray-200 rounded overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          {/* 会社名・URL / 結果フィルタ */}
          <form method="get" className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">会社名・URL</label>
              <input
                name="q"
                defaultValue={q}
                placeholder="会社名 or URL（部分一致）"
                className="w-full md:w-1/2 border border-gray-300 rounded px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">結果</label>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {BUCKET_ORDER.map((b) => (
                  <label key={b} className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      name="rb"
                      value={b}
                      defaultChecked={rbSet.has(b)}
                      className="rounded border-gray-300"
                    />
                    {BUCKET_LABEL[b]}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="px-4 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm">
                検索
              </button>
              <Link href={`/send/${id}`} className="px-4 py-1.5 rounded border border-gray-300 hover:bg-gray-50 text-sm">
                クリア
              </Link>
              <a
                href={exportHref}
                className="ml-auto px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 text-sm"
              >
                ⬇ ダウンロード
              </a>
            </div>
          </form>
        </div>

        <div className="px-4 py-2 text-xs text-gray-500 border-b border-gray-100">
          ■ 送信結果 {filteredResults.length} 件
          {(q || rbSet.size > 0) && <>（全 {job.results.length} 件中）</>}
          <span className="ml-2 text-gray-400">
            ※ 結果が「未実行」「キャンセル」の行は CSV に含まれません
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-medium">会社名 / URL</th>
                <th className="text-left px-3 py-2 font-medium w-24">結果</th>
                <th className="text-left px-3 py-2 font-medium">エラー</th>
                {job.trackUrlClicks && (
                  <th className="text-left px-3 py-2 font-medium w-24">URLクリック</th>
                )}
                <th className="text-left px-3 py-2 font-medium w-24">送信後画像</th>
                <th className="text-center px-3 py-2 font-medium w-24">手動送信済</th>
                <th className="text-left px-3 py-2 font-medium w-56">備考</th>
                <th className="text-left px-3 py-2 font-medium w-32">登録日時</th>
                <th className="text-left px-3 py-2 font-medium w-32">実行日時</th>
                <th className="text-left px-3 py-2 font-medium w-32">更新日時</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-gray-500">
                    該当する結果がありません。
                  </td>
                </tr>
              )}
              {filteredResults.map((r) => {
                const b = bucketOf(r.status, r.errorType);
                return (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                    <td className="px-3 py-2 max-w-[260px]">
                      <div className="truncate">{r.company.name}</div>
                      <a
                        href={r.company.formUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-gray-500 hover:underline truncate block max-w-[240px]"
                      >
                        {r.company.formUrl}
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded ${BUCKET_BADGE[b]}`}>
                        {BUCKET_LABEL[b]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px]">
                      {r.errorType ? (
                        <span title={r.errorMessage ?? ""} className="truncate block">
                          {r.errorType}
                          {r.errorMessage ? ` — ${r.errorMessage.slice(0, 40)}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    {job.trackUrlClicks && (
                      <td className="px-3 py-2 text-xs">
                        {r.urlClicks > 0 ? (
                          <span className="text-green-700 font-semibold">{r.urlClicks} クリック</span>
                        ) : (
                          <span className="text-gray-400">未クリック</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      {shotIds.has(r.id) ? (
                        <a href={`/api/send/screenshot/${r.id}`} target="_blank" rel="noreferrer" title="クリックで拡大表示">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/send/screenshot/${r.id}`}
                            alt={`${r.company.name} のスクリーンショット`}
                            className="h-12 w-20 object-cover object-top border border-gray-200 rounded hover:ring-2 hover:ring-[#1e5ab4]"
                          />
                        </a>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <form action={toggleResultManualSentAction.bind(null, r.id, id)}>
                        <button
                          title={r.manualSent ? "手動送信済（クリックで解除）" : "未（クリックで手動送信済に）"}
                          className={`text-lg leading-none ${r.manualSent ? "" : "opacity-30 grayscale"}`}
                        >
                          🚩
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-2">
                      <form action={updateResultNoteAction.bind(null, r.id, id)} className="flex items-center gap-1">
                        <input
                          name="note"
                          defaultValue={r.note ?? ""}
                          maxLength={500}
                          placeholder="備考"
                          className="w-40 border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                        <button className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 text-xs">
                          保存
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">{fmtJstDateTime(r.createdAt)}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{fmtJstDateTime(r.attemptedAt)}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{fmtJstDateTime(r.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SenderRow({
  label,
  children,
  highlight,
}: {
  label: string;
  children: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[160px_1fr] items-center px-5 py-3 border-b border-gray-100 ${
        highlight ? "bg-gray-50" : "bg-white"
      }`}
    >
      <dt className="text-gray-600 font-medium">{label}</dt>
      <dd className="text-gray-900">{children}</dd>
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
