import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { STATUS_BADGE, STATUS_LABEL, STATUS_OPTIONS } from "@/lib/case-status";
import { fmtJstDate } from "@/lib/date-jst";
import type { CaseStatus } from "@mvp/db";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ q?: string; status?: string; from?: string; to?: string }>;

function parseStatus(s?: string): CaseStatus | undefined {
  if (!s) return undefined;
  return (STATUS_OPTIONS as string[]).includes(s) ? (s as CaseStatus) : undefined;
}

export default async function CasesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const status = parseStatus(sp.status);
  const from = sp.from ? new Date(sp.from) : undefined;
  const to = sp.to ? new Date(sp.to) : undefined;

  const cases = await prisma.case.findMany({
    where: {
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sponsor: { contains: q, mode: "insensitive" } }] } : {}),
      ...(status ? { status } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "案件一覧" }]} />

      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold">案件一覧</h1>
        <Link
          href="/cases/new"
          className="px-3 py-2 rounded bg-[#1e5ab4] text-white text-sm hover:bg-[#17498f]"
        >
          ＋ 新規案件
        </Link>
      </div>

      <form className="bg-white rounded border border-gray-200 p-4 mb-5 grid grid-cols-1 md:grid-cols-5 gap-3 text-sm">
        <div className="md:col-span-2">
          <label className="block text-xs text-gray-500 mb-1">検索 (案件名 / スポンサー)</label>
          <input
            name="q"
            defaultValue={q}
            className="w-full border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-[#1e5ab4]"
            placeholder="例: 春キャンペーン"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">ステータス</label>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">すべて</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">作成日 (開始)</label>
          <input
            name="from"
            type="date"
            defaultValue={sp.from ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">作成日 (終了)</label>
          <input
            name="to"
            type="date"
            defaultValue={sp.to ?? ""}
            className="w-full border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
        <div className="md:col-span-5 flex justify-end gap-2">
          <Link href="/cases" className="px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50">
            クリア
          </Link>
          <button className="px-4 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f]">
            検索
          </button>
        </div>
      </form>

      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">案件名</th>
              <th className="text-left px-4 py-2 font-medium">スポンサー</th>
              <th className="text-left px-4 py-2 font-medium">ジャンル</th>
              <th className="text-left px-4 py-2 font-medium">ステータス</th>
              <th className="text-left px-4 py-2 font-medium">期間</th>
              <th className="text-left px-4 py-2 font-medium">更新日</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  案件がまだありません。右上の「＋ 新規案件」から登録してください。
                </td>
              </tr>
            )}
            {cases.map((c) => (
              <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/cases/${c.id}`} className="hover:text-[#1e5ab4]">
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-3">{c.sponsor}</td>
                <td className="px-4 py-3 text-gray-600">{c.genre ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded ${STATUS_BADGE[c.status]}`}>
                    {STATUS_LABEL[c.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                  {formatDate(c.startDate)} ~ {formatDate(c.endDate)}
                </td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                  {fmtJstDate(c.updatedAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/cases/${c.id}`}
                    className="text-[#1e5ab4] hover:underline text-xs"
                  >
                    編集
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDate(d: Date | null) {
  return fmtJstDate(d);
}
