import Link from "next/link";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { fmtJstDate } from "@/lib/date-jst";
import { duplicateSenderTemplateAction, deleteSenderTemplateAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SenderTemplatesPage() {
  const templates = await prisma.senderTemplate.findMany({
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "送信元テンプレート" }]} />
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold">送信元テンプレート</h1>
        <Link
          href="/templates/sender/new"
          className="px-3 py-2 rounded bg-[#1e5ab4] text-white text-sm hover:bg-[#17498f]"
        >
          ＋ 新規作成
        </Link>
      </div>
      <p className="text-sm text-gray-600 mb-5">
        差出人プロファイル（会社名・担当者・連絡先）を再利用管理します。送信実行時に選択して入力欄を自動フィルします。
      </p>

      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">テンプレ名</th>
              <th className="text-left px-4 py-2 font-medium">会社名</th>
              <th className="text-left px-4 py-2 font-medium">担当者</th>
              <th className="text-left px-4 py-2 font-medium">メール</th>
              <th className="text-left px-4 py-2 font-medium">電話</th>
              <th className="text-left px-4 py-2 font-medium w-28">更新日</th>
              <th className="px-4 py-2 w-40" />
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  送信元テンプレートがまだありません。
                </td>
              </tr>
            )}
            {templates.map((t) => {
              const dupAction = duplicateSenderTemplateAction.bind(null, t.id);
              const delAction = deleteSenderTemplateAction.bind(null, t.id);
              return (
                <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/templates/sender/${t.id}`} className="hover:text-[#1e5ab4]">
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{t.companyName}</td>
                  <td className="px-4 py-3">{t.personName}</td>
                  <td className="px-4 py-3 text-gray-600">{t.email}</td>
                  <td className="px-4 py-3 text-gray-600">{t.phone ?? "—"}</td>
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
