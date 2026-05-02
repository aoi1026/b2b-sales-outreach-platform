import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { fmtJstDate } from "@/lib/date-jst";

export const dynamic = "force-dynamic";

export default async function ListsPage() {
  const lists = await prisma.list.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { companies: true, caseLists: true } } },
    take: 200,
  });

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "保存済みリスト" }]} />
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold">保存済みリスト</h1>
        <Link
          href="/lists/import"
          className="px-3 py-2 rounded bg-[#1e5ab4] text-white text-sm hover:bg-[#17498f]"
        >
          ＋ リスト取込
        </Link>
      </div>

      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">リスト名</th>
              <th className="text-left px-4 py-2 font-medium">説明</th>
              <th className="text-left px-4 py-2 font-medium">企業数</th>
              <th className="text-left px-4 py-2 font-medium">紐付け案件</th>
              <th className="text-left px-4 py-2 font-medium">更新日</th>
            </tr>
          </thead>
          <tbody>
            {lists.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-gray-500">
                  リストがまだありません。右上の「＋ リスト取込」から CSV を取り込んでください。
                </td>
              </tr>
            )}
            {lists.map((l) => (
              <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/lists/${l.id}`} className="hover:text-[#1e5ab4]">
                    {l.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-gray-600 truncate max-w-xs">{l.description ?? "—"}</td>
                <td className="px-4 py-3">{l._count.companies}</td>
                <td className="px-4 py-3 text-gray-600">{l._count.caseLists}</td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                  {fmtJstDate(l.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
