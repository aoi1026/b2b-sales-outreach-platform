import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { fmtJstDateTime } from "@/lib/date-jst";
import { toggleRecipeAction, deleteRecipeAction } from "./actions";

export const dynamic = "force-dynamic";

type Plan = {
  fills?: unknown[];
  submitSelectors?: unknown[];
  successText?: string;
};

export default async function RecipesPage() {
  const recipes = await prisma.formRecipe.findMany({
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
    take: 500,
  });

  const enabledCount = recipes.filter((r) => r.enabled).length;
  const totalSuccess = recipes.reduce((a, r) => a + r.successCount, 0);

  return (
    <div>
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "学習レシピ (AI)" }]} />
      <h1 className="text-2xl font-bold mb-2">学習レシピ (AI フォーム解析)</h1>
      <p className="text-sm text-gray-600 mb-6">
        通常送信が失敗したフォームを Claude が解析し、成功した送信手順を「レシピ」としてドメイン単位で
        学習・保存します。次回以降は同じドメインでこのレシピを再利用するため、AI 呼び出しを減らしつつ
        成功率が安定します。うまくいかなくなったレシピは無効化・削除すると、次回 AI が作り直します。
      </p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="学習済みドメイン" value={recipes.length} />
        <Stat label="有効" value={enabledCount} color="text-green-700" />
        <Stat label="累計成功回数" value={totalSuccess} color="text-[#1e5ab4]" />
      </div>

      <section className="bg-white border border-gray-200 rounded overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-600">
          ■ レシピ一覧 ({recipes.length} 件)
        </div>
        {recipes.length === 0 ? (
          <p className="px-4 py-8 text-sm text-gray-500 text-center">
            まだ学習されたレシピはありません。AI 再送が成功すると自動的にここに追加されます。
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-medium">ドメイン</th>
                <th className="text-left px-3 py-2 font-medium w-20">状態</th>
                <th className="text-left px-3 py-2 font-medium w-16">成功</th>
                <th className="text-left px-3 py-2 font-medium w-16">失敗</th>
                <th className="text-left px-3 py-2 font-medium w-24">項目/ボタン</th>
                <th className="text-left px-3 py-2 font-medium w-36">最終利用 (JST)</th>
                <th className="text-left px-3 py-2 font-medium w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {recipes.map((r) => {
                const plan = (r.plan ?? {}) as Plan;
                const fills = Array.isArray(plan.fills) ? plan.fills.length : 0;
                const btns = Array.isArray(plan.submitSelectors) ? plan.submitSelectors.length : 0;
                const toggle = toggleRecipeAction.bind(null, r.id, !r.enabled);
                const del = deleteRecipeAction.bind(null, r.id);
                return (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                    <td className="px-3 py-2 font-mono text-xs break-all">{r.domain}</td>
                    <td className="px-3 py-2">
                      {r.enabled ? (
                        <span className="inline-block text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">
                          有効
                        </span>
                      ) : (
                        <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600">
                          無効
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-green-700">{r.successCount}</td>
                    <td className="px-3 py-2 text-red-700">{r.failCount}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {fills} / {btns}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {fmtJstDateTime(r.lastUsedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <form action={toggle}>
                          <button className="px-2 py-1 border border-gray-300 rounded hover:bg-gray-100 text-xs">
                            {r.enabled ? "無効化" : "有効化"}
                          </button>
                        </form>
                        <form action={del}>
                          <button className="px-2 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50 text-xs">
                            削除
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${color ?? ""}`}>{value}</div>
    </div>
  );
}
