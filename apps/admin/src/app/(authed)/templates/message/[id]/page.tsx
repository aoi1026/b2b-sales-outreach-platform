import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { getCharPresets } from "@/lib/settings";
import MessageTemplateForm from "../MessageTemplateForm";

export const dynamic = "force-dynamic";

export default async function EditMessageTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [t, charPresets] = await Promise.all([
    prisma.messageTemplate.findUnique({ where: { id } }),
    getCharPresets(),
  ]);
  if (!t) notFound();

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "送信文章テンプレート", href: "/templates/message" },
          { label: t.name },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">送信文章テンプレート 編集</h1>
      <MessageTemplateForm
        mode="edit"
        charPresets={charPresets}
        defaults={{ id: t.id, name: t.name, subject: t.subject, body: t.body }}
      />
    </div>
  );
}
