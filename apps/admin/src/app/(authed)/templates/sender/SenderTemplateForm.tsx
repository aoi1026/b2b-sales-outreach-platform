import Link from "next/link";
import { createSenderTemplateAction, updateSenderTemplateAction } from "./actions";

type Defaults = {
  id: string;
  name: string;
  companyName: string;
  personName: string;
  email: string;
  phone: string | null;
  postalCode: string | null;
  address: string | null;
  url: string | null;
};

export default function SenderTemplateForm({
  mode,
  defaults,
}: {
  mode: "create" | "edit";
  defaults?: Defaults;
}) {
  const action =
    mode === "create"
      ? createSenderTemplateAction
      : updateSenderTemplateAction.bind(null, defaults!.id);

  return (
    <form action={action} className="bg-white border border-gray-200 rounded p-6 space-y-4 max-w-3xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="テンプレート名" name="name" required defaultValue={defaults?.name} maxLength={120} />
        <Field label="会社名" name="companyName" required defaultValue={defaults?.companyName} maxLength={200} />
        <Field label="担当者氏名" name="personName" required defaultValue={defaults?.personName} maxLength={120} />
        <Field label="メールアドレス" name="email" type="email" required defaultValue={defaults?.email} maxLength={200} />
        <Field label="電話番号" name="phone" defaultValue={defaults?.phone ?? ""} maxLength={40} />
        <Field label="郵便番号" name="postalCode" defaultValue={defaults?.postalCode ?? ""} maxLength={20} />
      </div>
      <Field label="住所" name="address" defaultValue={defaults?.address ?? ""} maxLength={300} />
      <Field label="自社URL" name="url" defaultValue={defaults?.url ?? ""} maxLength={500} placeholder="https://..." />

      <div className="flex gap-3 pt-2">
        <button className="px-4 py-2 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm">
          {mode === "create" ? "作成" : "保存"}
        </button>
        <Link
          href="/templates/sender"
          className="px-4 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm"
        >
          キャンセル
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  required,
  maxLength,
  placeholder,
  type,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm mb-1">
        {label}
        {required && <span className="text-red-600 ml-1">*</span>}
      </label>
      <input
        type={type ?? "text"}
        name={name}
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
      />
    </div>
  );
}
