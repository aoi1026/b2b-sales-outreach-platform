import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import NewJobClient from "./NewJobClient";

export const dynamic = "force-dynamic";

export default async function NewSendJobPage() {
  const [cases, lists, msgTemplates, senderTemplates] = await Promise.all([
    prisma.case.findMany({
      where: { status: { in: ["PREPARING", "RUNNING"] } },
      orderBy: { updatedAt: "desc" },
      include: {
        caseLists: { include: { list: true } },
        caseTemplates: { include: { messageTemplate: true, senderTemplate: true } },
      },
    }),
    prisma.list.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { companies: true } } },
    }),
    prisma.messageTemplate.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.senderTemplate.findMany({ orderBy: { updatedAt: "desc" } }),
  ]);

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "自動送信", href: "/send" },
          { label: "新規ジョブ" },
        ]}
      />
      <h1 className="text-2xl font-bold mb-2">自動送信 新規ジョブ作成</h1>
      <p className="text-sm text-gray-600 mb-6">
        案件・リスト・テンプレートを選択して、送信ジョブを作成します。送信上限は 1 ジョブ
        50 件です。
      </p>

      <NewJobClient
        cases={cases.map((c) => ({
          id: c.id,
          name: c.name,
          linkedListIds: c.caseLists.map((cl) => cl.listId),
          linkedMessageTemplateIds: c.caseTemplates.map((ct) => ct.messageTemplateId),
          linkedSenderTemplateIds: c.caseTemplates
            .map((ct) => ct.senderTemplateId)
            .filter((v): v is string => !!v),
        }))}
        lists={lists.map((l) => ({ id: l.id, name: l.name, companyCount: l._count.companies }))}
        msgTemplates={msgTemplates.map((t) => ({ id: t.id, name: t.name, subject: t.subject }))}
        senderTemplates={senderTemplates.map((s) => ({
          id: s.id,
          name: s.name,
          companyName: s.companyName,
          personName: s.personName,
        }))}
      />
    </div>
  );
}
