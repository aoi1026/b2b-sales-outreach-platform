import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs from "@/components/Breadcrumbs";
import { prisma } from "@/lib/db";
import { updateCompanyAction } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function CompanyEditPage({
  params,
}: {
  params: Promise<{ id: string; cid: string }>;
}) {
  const { id, cid } = await params;
  const [list, company] = await Promise.all([
    prisma.list.findUnique({ where: { id } }),
    prisma.company.findUnique({ where: { id: cid } }),
  ]);
  if (!list || !company || company.listId !== id) notFound();

  const action = updateCompanyAction.bind(null, id, cid);

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "保存済みリスト", href: "/lists" },
          { label: list.name, href: `/lists/${id}` },
          { label: "企業編集" },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">企業情報編集</h1>

      <form action={action} className="bg-white border border-gray-200 rounded p-6 space-y-4 max-w-2xl">
        <Field label="会社名" name="name" required defaultValue={company.name} />
        <Field label="問い合わせフォームURL" name="formUrl" required defaultValue={company.formUrl} />
        <Field label="サイトURL" name="siteUrl" defaultValue={company.siteUrl ?? ""} />
        <Field label="メール" name="email" defaultValue={company.email ?? ""} />
        <Field label="業種" name="industry" defaultValue={company.industry ?? ""} />

        <div className="flex gap-3 pt-2">
          <button className="px-4 py-2 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm">
            保存
          </button>
          <Link
            href={`/lists/${id}`}
            className="px-4 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm"
          >
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm mb-1">
        {label}
        {required && <span className="text-red-600 ml-1">*</span>}
      </label>
      <input
        name={name}
        defaultValue={defaultValue}
        required={required}
        className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
      />
    </div>
  );
}
