import Breadcrumbs from "@/components/Breadcrumbs";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCharPresets, getDefaultSenderTemplateId } from "@/lib/settings";
import {
  updateCharPresetsAction,
  updateDefaultSenderTemplateAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [user, charPresets, defaultSenderId, senderTemplates] = await Promise.all([
    requireUser(),
    getCharPresets(),
    getDefaultSenderTemplateId(),
    prisma.senderTemplate.findMany({ orderBy: { updatedAt: "desc" } }),
  ]);

  return (
    <div className="max-w-3xl">
      <Breadcrumbs items={[{ label: "TOP", href: "/home" }, { label: "設定" }]} />
      <h1 className="text-2xl font-bold mb-6">設定</h1>

      <section className="bg-white border border-gray-200 rounded p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-4">■ アカウント情報</h2>
        <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-sm">
          <dt className="text-gray-500">表示名</dt>
          <dd>{user?.name ?? "—"}</dd>
          <dt className="text-gray-500">メールアドレス</dt>
          <dd>{user?.email ?? "—"}</dd>
        </dl>
      </section>

      <section className="bg-white border border-gray-200 rounded p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-4">■ 文字数プリセット</h2>
        <p className="text-xs text-gray-500 mb-3">
          送信文章テンプレ編集で選択できる文字数上限のプリセット（カンマ区切り、半角数字）。
        </p>
        <form action={updateCharPresetsAction} className="flex gap-2 text-sm">
          <input
            name="presets"
            defaultValue={charPresets.join(",")}
            placeholder="200, 500, 1000"
            className="flex-1 border border-gray-300 rounded px-3 py-1.5"
          />
          <button className="px-4 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f]">
            保存
          </button>
        </form>
        <div className="mt-2 text-[11px] text-gray-500">
          現在の設定:{" "}
          {charPresets.length > 0 ? charPresets.map((p) => `${p}字`).join(" / ") : "なし"}
        </div>
      </section>

      <section className="bg-white border border-gray-200 rounded p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-4">■ 送信元テンプレート 既定値</h2>
        <p className="text-xs text-gray-500 mb-3">
          案件に送信元テンプレが紐付けられていない場合に使用する既定の差出人プロファイル。
        </p>
        <form action={updateDefaultSenderTemplateAction} className="flex gap-2 text-sm">
          <select
            name="senderTemplateId"
            defaultValue={defaultSenderId ?? ""}
            className="flex-1 border border-gray-300 rounded px-3 py-1.5"
          >
            <option value="">（未設定）</option>
            {senderTemplates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.personName})
              </option>
            ))}
          </select>
          <button className="px-4 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f]">
            保存
          </button>
        </form>
      </section>

      <section className="bg-white border border-dashed border-gray-300 rounded p-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-2">■ CSV既定項目</h2>
        <p className="text-sm text-gray-500">
          リスト取込時の項目マッピングは現在自動検出で対応しています。既定値の固定化は MS6 での UI
          微調整タイミングで対応可能（必要時）。
        </p>
      </section>
    </div>
  );
}
