import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { STATUS_BADGE, STATUS_LABEL } from "@/lib/case-status";
import CaseForm from "../CaseForm";
import { updateCaseAction, deleteCaseAction, duplicateCaseAction } from "../actions";
import {
  attachListAction,
  detachListAction,
  attachMessageTemplateAction,
  detachMessageTemplateAction,
  updateCaseTemplateSenderAction,
} from "./link-actions";
import { fmtJstDate } from "@/lib/date-jst";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function CaseDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const [c, allLists, allMsgTemplates, allSenderTemplates] = await Promise.all([
    prisma.case.findUnique({
      where: { id },
      include: {
        caseLists: {
          include: { list: { include: { _count: { select: { companies: true } } } } },
          orderBy: { createdAt: "desc" },
        },
        caseTemplates: {
          include: { messageTemplate: true, senderTemplate: true },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    prisma.list.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.messageTemplate.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.senderTemplate.findMany({ orderBy: { updatedAt: "desc" } }),
  ]);
  if (!c) notFound();

  const bound = updateCaseAction.bind(null, id);
  const del = deleteCaseAction.bind(null, id);
  const dup = duplicateCaseAction.bind(null, id);
  const attachList = attachListAction.bind(null, id);
  const attachMsg = attachMessageTemplateAction.bind(null, id);

  const attachedListIds = new Set(c.caseLists.map((cl) => cl.listId));
  const attachedMsgIds = new Set(c.caseTemplates.map((ct) => ct.messageTemplateId));
  const availableLists = allLists.filter((l) => !attachedListIds.has(l.id));
  const availableMsgTemplates = allMsgTemplates.filter((t) => !attachedMsgIds.has(t.id));

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "案件一覧", href: "/cases" },
          { label: c.name },
        ]}
      />

      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold">{c.name}</h1>
          <div className="mt-1 text-sm text-gray-500 flex items-center gap-3">
            <span className={`inline-block text-xs px-2 py-0.5 rounded ${STATUS_BADGE[c.status]}`}>
              {STATUS_LABEL[c.status]}
            </span>
            <span>作成 {fmtJstDate(c.createdAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <form action={dup}>
            <button className="px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 text-sm">
              複製
            </button>
          </form>
          <form action={del}>
            <button className="px-3 py-1.5 border border-red-300 text-red-700 rounded hover:bg-red-50 text-sm">
              削除
            </button>
          </form>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h2 className="text-sm font-semibold text-gray-600 mb-2">■ 基本情報 (編集)</h2>
          <CaseForm action={bound} initial={c} submitLabel="更新" />
        </section>

        <div className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold text-gray-600 mb-2">■ 紐付けリスト</h2>
            <div className="bg-white border border-gray-200 rounded p-4 space-y-3">
              {c.caseLists.length === 0 ? (
                <p className="text-sm text-gray-500">紐付けられているリストはありません。</p>
              ) : (
                <ul className="text-sm divide-y divide-gray-100">
                  {c.caseLists.map((cl) => {
                    const detach = detachListAction.bind(null, id, cl.listId);
                    return (
                      <li key={cl.listId} className="flex items-center justify-between py-1.5">
                        <Link href={`/lists/${cl.listId}`} className="hover:text-[#1e5ab4]">
                          {cl.list.name}
                          <span className="text-xs text-gray-500 ml-2">
                            ({cl.list._count.companies} 件)
                          </span>
                        </Link>
                        <form action={detach}>
                          <button className="text-red-600 text-xs hover:underline">解除</button>
                        </form>
                      </li>
                    );
                  })}
                </ul>
              )}
              {availableLists.length > 0 && (
                <form action={attachList} className="flex gap-2 pt-2 border-t border-gray-100">
                  <select
                    name="listId"
                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                    defaultValue=""
                    required
                  >
                    <option value="">（リストを選択）</option>
                    {availableLists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button className="px-3 py-1 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm">
                    ＋ 紐付け
                  </button>
                </form>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-600 mb-2">■ 紐付けテンプレート</h2>
            <div className="bg-white border border-gray-200 rounded p-4 space-y-3">
              {c.caseTemplates.length === 0 ? (
                <p className="text-sm text-gray-500">紐付けられているテンプレートはありません。</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {c.caseTemplates.map((ct) => {
                    const detach = detachMessageTemplateAction.bind(
                      null,
                      id,
                      ct.messageTemplateId,
                    );
                    const updateSender = updateCaseTemplateSenderAction.bind(
                      null,
                      id,
                      ct.messageTemplateId,
                    );
                    return (
                      <li key={ct.messageTemplateId} className="py-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Link
                            href={`/templates/message/${ct.messageTemplateId}`}
                            className="text-sm font-medium hover:text-[#1e5ab4]"
                          >
                            {ct.messageTemplate.name}
                          </Link>
                          <form action={detach}>
                            <button className="text-red-600 text-xs hover:underline">解除</button>
                          </form>
                        </div>
                        <form action={updateSender} className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 w-20 shrink-0">送信元:</label>
                          <select
                            name="senderTemplateId"
                            defaultValue={ct.senderTemplateId ?? ""}
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
                          >
                            <option value="">（指定しない）</option>
                            {allSenderTemplates.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name} ({s.personName})
                              </option>
                            ))}
                          </select>
                          <button className="text-[#1e5ab4] text-xs hover:underline">保存</button>
                        </form>
                      </li>
                    );
                  })}
                </ul>
              )}
              {availableMsgTemplates.length > 0 && (
                <form action={attachMsg} className="flex gap-2 pt-2 border-t border-gray-100">
                  <select
                    name="messageTemplateId"
                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                    defaultValue=""
                    required
                  >
                    <option value="">（送信文章テンプレを選択）</option>
                    {availableMsgTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button className="px-3 py-1 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm">
                    ＋ 紐付け
                  </button>
                </form>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-600 mb-2">■ 配信結果サマリ</h2>
            <div className="bg-white rounded border border-dashed border-gray-300 p-5 text-sm text-gray-500">
              MS5 (配信結果) 実装後に有効化されます。
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
