import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import {
  updateListAction,
  deleteListAction,
  addCompanyAction,
  deleteCompanyAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function ListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const list = await prisma.list.findUnique({
    where: { id },
    include: { companies: { orderBy: { createdAt: "desc" } } },
  });
  if (!list) notFound();

  const updateAction = updateListAction.bind(null, id);
  const deleteAction = deleteListAction.bind(null, id);
  const addAction = addCompanyAction.bind(null, id);

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "保存済みリスト", href: "/lists" },
          { label: list.name },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">{list.name}</h1>

      <section className="bg-white border border-gray-200 rounded p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ リスト情報</h2>
        <div className="max-w-2xl flex items-start gap-3">
          <form action={updateAction} className="flex-1 space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">リスト名</label>
              <input
                name="name"
                defaultValue={list.name}
                required
                maxLength={120}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">説明</label>
              <textarea
                name="description"
                defaultValue={list.description ?? ""}
                rows={2}
                maxLength={500}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm"
            >
              保存
            </button>
          </form>
          <form action={deleteAction}>
            <button
              type="submit"
              className="px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 text-sm"
            >
              リスト削除
            </button>
          </form>
        </div>
      </section>

      <section className="bg-white border border-gray-200 rounded p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">
          ■ 企業を追加 ({list.companies.length} 件)
        </h2>
        <form action={addAction} className="grid grid-cols-1 md:grid-cols-5 gap-2 text-sm">
          <input
            name="name"
            placeholder="会社名 *"
            required
            maxLength={200}
            className="border border-gray-300 rounded px-2 py-1.5"
          />
          <input
            name="formUrl"
            placeholder="問い合わせフォームURL *"
            required
            maxLength={500}
            className="border border-gray-300 rounded px-2 py-1.5 md:col-span-2"
          />
          <input
            name="siteUrl"
            placeholder="サイトURL"
            maxLength={500}
            className="border border-gray-300 rounded px-2 py-1.5"
          />
          <input
            name="email"
            placeholder="メール"
            maxLength={200}
            className="border border-gray-300 rounded px-2 py-1.5"
          />
          <input
            name="industry"
            placeholder="業種"
            maxLength={80}
            className="border border-gray-300 rounded px-2 py-1.5"
          />
          <button className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] md:col-span-1">
            ＋ 追加
          </button>
        </form>
      </section>

      <section className="bg-white border border-gray-200 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">会社名</th>
              <th className="text-left px-3 py-2 font-medium">フォームURL</th>
              <th className="text-left px-3 py-2 font-medium">サイト</th>
              <th className="text-left px-3 py-2 font-medium">メール</th>
              <th className="text-left px-3 py-2 font-medium">業種</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.companies.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  このリストには企業がまだありません。
                </td>
              </tr>
            )}
            {list.companies.map((c) => {
              const delAction = deleteCompanyAction.bind(null, id, c.id);
              return (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/lists/${id}/companies/${c.id}`}
                      className="hover:text-[#1e5ab4]"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 truncate max-w-[200px]">
                    <a href={c.formUrl} target="_blank" rel="noreferrer" className="hover:underline">
                      {c.formUrl}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 truncate max-w-[140px]">
                    {c.siteUrl ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">{c.email ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{c.industry ?? "—"}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Link
                      href={`/lists/${id}/companies/${c.id}`}
                      className="text-[#1e5ab4] text-xs hover:underline mr-3"
                    >
                      編集
                    </Link>
                    <form action={delAction} className="inline">
                      <button className="text-red-600 text-xs hover:underline">削除</button>
                    </form>
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
