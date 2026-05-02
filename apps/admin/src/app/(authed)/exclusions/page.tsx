import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { fmtJstDate } from "@/lib/date-jst";
import { addBlacklistAction, deleteBlacklistAction } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_LABEL = { DOMAIN: "ドメイン", COMPANY_NAME: "会社名" } as const;
const SOURCE_LABEL = { MANUAL: "手動", AUTO_KEYWORD: "取込時自動" } as const;

export default async function ExclusionsPage() {
  const entries = await prisma.blacklistEntry.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const counts = {
    domain: entries.filter((e) => e.type === "DOMAIN").length,
    company: entries.filter((e) => e.type === "COMPANY_NAME").length,
    auto: entries.filter((e) => e.source === "AUTO_KEYWORD").length,
  };

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "送信除外設定" }]} />
      <h1 className="text-2xl font-bold mb-2">送信除外設定 (ブラックリスト)</h1>
      <p className="text-sm text-gray-600 mb-6">
        ドメインまたは会社名を登録すると、CSV取込時と送信実行時に該当先が自動的に除外されます。
      </p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="ドメイン登録" value={counts.domain} />
        <Stat label="会社名登録" value={counts.company} />
        <Stat label="取込時自動追加" value={counts.auto} />
      </div>

      <section className="bg-white border border-gray-200 rounded p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ 新規登録</h2>
        <form action={addBlacklistAction} className="grid grid-cols-1 md:grid-cols-6 gap-2 text-sm">
          <select
            name="type"
            className="border border-gray-300 rounded px-2 py-1.5"
            defaultValue="DOMAIN"
          >
            <option value="DOMAIN">ドメイン</option>
            <option value="COMPANY_NAME">会社名</option>
          </select>
          <input
            name="value"
            placeholder="例: no-sales.example.com / 株式会社サンプル"
            required
            maxLength={300}
            className="border border-gray-300 rounded px-2 py-1.5 md:col-span-3"
          />
          <input
            name="reason"
            placeholder="理由 (任意)"
            maxLength={300}
            className="border border-gray-300 rounded px-2 py-1.5"
          />
          <button className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f]">
            ＋ 追加
          </button>
        </form>
      </section>

      <section className="bg-white border border-gray-200 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-24">種別</th>
              <th className="text-left px-3 py-2 font-medium">値</th>
              <th className="text-left px-3 py-2 font-medium">理由</th>
              <th className="text-left px-3 py-2 font-medium w-24">登録元</th>
              <th className="text-left px-3 py-2 font-medium w-28">登録日</th>
              <th className="px-3 py-2 w-16" />
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  ブラックリストは空です。上のフォームから登録してください。
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const delAction = deleteBlacklistAction.bind(null, e.id);
              return (
                <tr key={e.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block text-xs px-2 py-0.5 rounded ${
                        e.type === "DOMAIN"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-purple-50 text-purple-700"
                      }`}
                    >
                      {TYPE_LABEL[e.type]}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.value}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{e.reason ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={`${
                        e.source === "AUTO_KEYWORD" ? "text-orange-700" : "text-gray-600"
                      }`}
                    >
                      {SOURCE_LABEL[e.source]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                    {fmtJstDate(e.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <form action={delAction}>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white border border-gray-200 rounded p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
