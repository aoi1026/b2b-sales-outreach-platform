import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { JOB_STATUS_BADGE, JOB_STATUS_LABEL } from "@/lib/delivery-status";
import { fmtJstDate } from "@/lib/date-jst";
import DeleteJobButton from "./DeleteJobButton";

export const dynamic = "force-dynamic";

export default async function SendJobsPage() {
  const jobs = await prisma.deliveryJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      case: true,
      list: true,
      messageTemplate: true,
    },
  });

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "自動送信" }]} />
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold">自動送信ジョブ</h1>
        <Link
          href="/send/new"
          className="px-3 py-2 rounded bg-[#1e5ab4] text-white text-sm hover:bg-[#17498f]"
        >
          ＋ 新規ジョブ
        </Link>
      </div>

      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">ジョブ</th>
              <th className="text-left px-4 py-2 font-medium">案件</th>
              <th className="text-left px-4 py-2 font-medium">リスト</th>
              <th className="text-left px-4 py-2 font-medium">テンプレ</th>
              <th className="text-left px-4 py-2 font-medium">ステータス</th>
              <th className="text-left px-4 py-2 font-medium">進捗</th>
              <th className="text-left px-4 py-2 font-medium w-28">作成日</th>
              <th className="text-left px-4 py-2 font-medium w-20">操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                  ジョブがまだありません。右上の「＋ 新規ジョブ」から作成してください。
                </td>
              </tr>
            )}
            {jobs.map((j) => {
              const processed = j.successCount + j.failedCount + j.skippedCount;
              return (
                <tr key={j.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/send/${j.id}`} className="hover:text-[#1e5ab4]">
                      {j.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{j.case.name}</td>
                  <td className="px-4 py-3 text-gray-600">{j.list.name}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{j.messageTemplate.name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs px-2 py-0.5 rounded ${JOB_STATUS_BADGE[j.status]}`}>
                      {JOB_STATUS_LABEL[j.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {processed} / {j.plannedCount}
                    <span className="text-gray-500 ml-2">
                      (成功 {j.successCount} / 失敗 {j.failedCount} / スキップ {j.skippedCount})
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {fmtJstDate(j.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <DeleteJobButton jobId={j.id} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
