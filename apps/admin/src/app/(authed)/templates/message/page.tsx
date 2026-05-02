import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { fmtJstDate } from "@/lib/date-jst";
import { duplicateMessageTemplateAction, deleteMessageTemplateAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function MessageTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const templates = await prisma.messageTemplate.findMany({
    where: q
      ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }] }
      : undefined,
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  return (
    <div>
      <Breadcrumbs
        items={[{ label: "TOP", href: "/home" }, { label: "送信文章テンプレート" }]}
      />
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold">送信文章テンプレート</h1>
        <Link
          href="/templates/message/new"
          className="px-3 py-2 rounded bg-[#1e5ab4] text-white text-sm hover:bg-[#17498f]"
        >
          ＋ 新規作成
        </Link>
      </div>

      <form className="bg-white rounded border border-gray-200 p-4 mb-5 flex gap-3 text-sm">
        <input
          name="q"
          defaultValue={q}
          placeholder="テンプレ名・件名で検索"
          className="flex-1 border border-gray-300 rounded px-3 py-1.5"
        />
        <button className="px-4 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f]">
          検索
        </button>
      </form>

      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">テンプレ名</th>
              <th className="text-left px-4 py-2 font-medium">件名</th>
              <th className="text-left px-4 py-2 font-medium w-24">本文文字数</th>
              <th className="text-left px-4 py-2 font-medium w-28">更新日</th>
              <th className="px-4 py-2 w-40" />
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-gray-500">
                  テンプレートがまだありません。
                </td>
              </tr>
            )}
            {templates.map((t) => {
              const dupAction = duplicateMessageTemplateAction.bind(null, t.id);
              const delAction = deleteMessageTemplateAction.bind(null, t.id);
              return (
                <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/templates/message/${t.id}`} className="hover:text-[#1e5ab4]">
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600 truncate max-w-xs">{t.subject}</td>
                  <td className="px-4 py-3 text-gray-600">{t.body.length}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {fmtJstDate(t.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <form action={dupAction} className="inline">
                      <button className="text-[#1e5ab4] text-xs hover:underline mr-3">複製</button>
                    </form>
                    <form action={delAction} className="inline">
                      <button className="text-red-600 text-xs hover:underline">削除</button>
                    </form>
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
