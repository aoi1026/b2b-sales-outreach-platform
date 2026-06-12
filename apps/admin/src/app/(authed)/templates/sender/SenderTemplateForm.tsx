import Link from "next/link";
import { createSenderTemplateAction, updateSenderTemplateAction } from "./actions";

type Defaults = {
  id: string;
  name: string;
  companyName: string;
  personName: string;
  familyName: string | null;
  givenName: string | null;
  familyNameKana: string | null;
  givenNameKana: string | null;
  personHiragana: string | null;
  personKatakana: string | null;
  department: string | null;
  position: string | null;
  email: string;
  phone: string | null;
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  addressLine: string | null;
  building: string | null;
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
    <form action={action} className="bg-white border border-gray-200 rounded p-6 space-y-5 max-w-3xl">
      <Field label="テンプレート名" name="name" required defaultValue={defaults?.name} maxLength={120} placeholder="例: 依田 送信用" />

      <Field label="会社名" name="companyName" required defaultValue={defaults?.companyName} maxLength={200} placeholder="株式会社〇〇" />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="郵便番号" name="postalCode" required defaultValue={defaults?.postalCode ?? ""} maxLength={20} placeholder="000-0000" />
        <Field label="都道府県" name="prefecture" required defaultValue={defaults?.prefecture ?? ""} maxLength={20} placeholder="東京都" />
        <Field label="市区町村" name="city" required defaultValue={defaults?.city ?? ""} maxLength={100} placeholder="港区" />
        <Field label="丁目番地" name="addressLine" required defaultValue={defaults?.addressLine ?? ""} maxLength={120} placeholder="東新橋2丁目11-7" />
      </div>
      <Field label="ビル名・部屋番号" name="building" defaultValue={defaults?.building ?? ""} maxLength={120} placeholder="住友東新橋ビル5号館3階" />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="部署" name="department" required defaultValue={defaults?.department ?? ""} maxLength={100} placeholder="営業部" />
        <Field label="役職" name="position" required defaultValue={defaults?.position ?? ""} maxLength={100} placeholder="一般 / 担当者" />
        <Field label="姓" name="familyName" required defaultValue={defaults?.familyName ?? ""} maxLength={60} placeholder="依田" />
        <Field label="名" name="givenName" required defaultValue={defaults?.givenName ?? ""} maxLength={60} placeholder="優真" />
        <Field label="姓 (カナ)" name="familyNameKana" required defaultValue={defaults?.familyNameKana ?? ""} maxLength={60} placeholder="ヨダ" />
        <Field label="名 (カナ)" name="givenNameKana" required defaultValue={defaults?.givenNameKana ?? ""} maxLength={60} placeholder="ユウマ" />
        <Field label="メールアドレス" name="email" type="email" required defaultValue={defaults?.email} maxLength={200} placeholder="yoda@example.co.jp" />
        <Field label="電話番号" name="phone" required defaultValue={defaults?.phone ?? ""} maxLength={40} placeholder="03-0000-0000" />
      </div>

      <Field label="自社URL" name="url" defaultValue={defaults?.url ?? ""} maxLength={500} placeholder="https://..." />

      <p className="text-[11px] text-gray-400">
        ※ 姓・名 / カナは自動送信時にフォームの姓名欄へ分割入力されます。都道府県〜ビル名は結合して住所欄に入力されます。
      </p>

      <div className="flex gap-3 pt-1">
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
