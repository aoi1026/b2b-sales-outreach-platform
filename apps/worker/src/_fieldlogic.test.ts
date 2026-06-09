// 氏名分割・フィールド役割判定の単体テスト (実フォームの name/placeholder を使用)。
// 実行: npx tsx src/_fieldlogic.test.ts
import { splitNameParts, detectFieldRole, pickValueForRole } from "./form-submitter.ts";
import type { FormInput } from "./types.ts";

let pass = 0;
let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// 送信元テンプレ (実ジョブ cmq63tott... と同じ・氏名に空白なし)
const person = "白石秀彦";
const { last: personLast, first: personFirst } = splitNameParts(person);
const input: FormInput = {
  company: "株式会社アド・フェニックス・エージェンシー",
  companyKana: null,
  person,
  personHiragana: "しらいしひでひこ",
  personKatakana: "シライシヒデヒコ",
  personKana: "シライシヒデヒコ",
  personLast,
  personFirst,
  email: "shiraishi@adphoenix.co.jp",
  phone: "0368091657",
  postalCode: "1050021",
  address: "東京都港区東新橋２丁目１１ー７",
  url: "https://www.adphoenix.co.jp/",
  subject: "ご提案",
  message: "本文",
  position: "担当者",
};

console.log("=== splitNameParts ===");
eq("kanji last", personLast, "白石");
eq("kanji first", personFirst, "秀彦");
eq("hira last", splitNameParts("しらいしひでひこ").last, "しらいし");
eq("hira first", splitNameParts("しらいしひでひこ").first, "ひでひこ");
eq("kata last", splitNameParts("シライシヒデヒコ").last, "シライシ");
eq("kata first", splitNameParts("シライシヒデヒコ").first, "ヒデヒコ");
eq("spaced last", splitNameParts("山田 太郎").last, "山田");
eq("spaced first", splitNameParts("山田 太郎").first, "太郎");

// ElementMeta を name/placeholder から組み立てる (getElementMeta と同形)
function meta(opts: {
  name?: string;
  id?: string;
  placeholder?: string;
  type?: string;
  tagName?: string;
  labelText?: string;
  autocomplete?: string;
}) {
  const name = opts.name ?? "";
  const id = opts.id ?? "";
  const placeholder = opts.placeholder ?? "";
  const type = opts.type ?? "text";
  const tagName = opts.tagName ?? "input";
  const labelText = opts.labelText ?? "";
  const autocomplete = opts.autocomplete ?? "";
  const dataColumn = "";
  return {
    name, id, placeholder, type, required: false, tagName, labelText, autocomplete, dataColumn,
    idLower: id.toLowerCase(),
    nameLower: name.toLowerCase(),
    combined: [name, id, placeholder, labelText, dataColumn, type].join("|").toLowerCase(),
  };
}

function roleVal(m: ReturnType<typeof meta>) {
  const role = detectFieldRole(m);
  return { role, value: pickValueForRole(role, input) };
}

console.log("\n=== kozen.co.jp ===");
{
  const r = roleVal(meta({ name: "lastName", placeholder: "姓" }));
  eq("lastName role", r.role, "person_last");
  eq("lastName value", r.value, "白石");
}
{
  const r = roleVal(meta({ name: "firstName", placeholder: "名" }));
  eq("firstName role", r.role, "person_first");
  eq("firstName value", r.value, "秀彦");
}
{
  const r = roleVal(meta({ name: "lastNameKana", placeholder: "せい" }));
  eq("lastNameKana role", r.role, "person_hiragana_last");
  eq("lastNameKana value", r.value, "しらいし");
}
{
  const r = roleVal(meta({ name: "firstNameKana", placeholder: "めい" }));
  eq("firstNameKana role", r.role, "person_hiragana_first");
  eq("firstNameKana value", r.value, "ひでひこ");
}
eq("mailCheck role", detectFieldRole(meta({ name: "mailCheck" })), "email_confirm");

console.log("\n=== retail-branding.co.jp (CF7) ===");
{
  // text-furigana: カタカナ想定 (フリガナ)
  const r = roleVal(meta({ name: "text-furigana", labelText: "フリガナ" }));
  eq("text-furigana role", r.role, "person_kana");
  eq("text-furigana value", r.value, "シライシヒデヒコ");
}
eq("email-conf role", detectFieldRole(meta({ name: "email-conf", type: "email" })), "email_confirm");

console.log("\n=== カタカナ 姓/名 分割 (セイ/メイ) ===");
{
  const r = roleVal(meta({ name: "sei", placeholder: "セイ" }));
  eq("sei(カナ) role", r.role, "person_kana_last");
  eq("sei(カナ) value", r.value, "シライシ");
}
{
  const r = roleVal(meta({ name: "mei", placeholder: "メイ" }));
  eq("mei(カナ) role", r.role, "person_kana_first");
  eq("mei(カナ) value", r.value, "ヒデヒコ");
}

console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "💥 FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
