import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import SenderTemplateForm from "../SenderTemplateForm";

export const dynamic = "force-dynamic";

export default async function EditSenderTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await prisma.senderTemplate.findUnique({ where: { id } });
  if (!t) notFound();

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "送信元テンプレート", href: "/templates/sender" },
          { label: t.name },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">送信元テンプレート 編集</h1>
      <SenderTemplateForm mode="edit" defaults={t} />
    </div>
  );
}
