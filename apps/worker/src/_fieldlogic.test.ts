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
  personLast: "白石",
  personFirst: "秀彦",
  email: "shiraishi@adphoenix.co.jp",
  phone: "03-6809-1657",
  postalCode: "105-0021",
  address: "東京都港区東新橋2丁目11-7住友東新橋ビル5号館3階",
  prefecture: "東京都",
  city: "港区",
  addressLine: "東新橋2丁目11-7",
  building: "住友東新橋ビル5号館3階",
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
  const className = "";
  return {
    name, id, placeholder, type, required: false, tagName, labelText, autocomplete, dataColumn, className,
    idLower: id.toLowerCase(),
    nameLower: name.toLowerCase(),
    combined: [name, id, placeholder, labelText, dataColumn, type, className].join("|").toLowerCase(),
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

console.log("\n=== asagami.co.jp (name が日本語ラベルそのもの) ===");
{
  const r = roleVal(meta({ name: "姓" }));
  eq("name=姓 role", r.role, "person_last");
  eq("name=姓 value", r.value, "白石");
}
{
  const r = roleVal(meta({ name: "名" }));
  eq("name=名 role", r.role, "person_first");
  eq("name=名 value", r.value, "秀彦");
}
{
  const r = roleVal(meta({ name: "セイ" }));
  eq("name=セイ role", r.role, "person_kana_last");
  eq("name=セイ value", r.value, "シライシ");
}
{
  const r = roleVal(meta({ name: "メイ" }));
  eq("name=メイ role", r.role, "person_kana_first");
  eq("name=メイ value", r.value, "ヒデヒコ");
}
// 会社名(会社名) を誤って person_first にしないこと (名 のトークン誤一致回避の確認)
eq("name=会社名 not person_first", detectFieldRole(meta({ name: "会社名" })) === "person_first", false);

console.log("\n=== reg26.smp.ne.jp (name/class/value に手掛かりなし・ラベルのみ) ===");
{
  // name はシステム生成、姓名はラベル(隣接テキスト)だけにある
  const r = roleVal(meta({ name: "item_001", labelText: "姓" }));
  eq("label=姓 role", r.role, "person_last");
  eq("label=姓 value", r.value, "白石");
}
{
  const r = roleVal(meta({ name: "item_002", labelText: "名" }));
  eq("label=名 role", r.role, "person_first");
  eq("label=名 value", r.value, "秀彦");
}
{
  const r = roleVal(meta({ name: "item_003", labelText: "セイ" }));
  eq("label=セイ role", r.role, "person_kana_last");
  eq("label=セイ value", r.value, "シライシ");
}
{
  const r = roleVal(meta({ name: "item_004", labelText: "メイ" }));
  eq("label=メイ role", r.role, "person_kana_first");
  eq("label=メイ value", r.value, "ヒデヒコ");
}
// ラベル「会社名」「お名前」「氏名」を 名(person_first) と誤検出しないこと
eq("label=会社名 not person_first", detectFieldRole(meta({ name: "x1", labelText: "会社名" })) === "person_first", false);
eq("label=お名前 not person_first", detectFieldRole(meta({ name: "x2", labelText: "お名前" })) === "person_first", false);

console.log("\n=== 電話/郵便のハイフン除去 (単一欄) ===");
eq("phone digits-only", roleVal(meta({ name: "tel" })).value, "0368091657");
eq("postal digits-only", roleVal(meta({ name: "zip" })).value, "1050021");

console.log("\n=== 住所の細分化 (個別値・スライスしない) ===");
eq("都道府県", roleVal(meta({ name: "pref", labelText: "都道府県" })).value, "東京都");
eq("市区町村", roleVal(meta({ name: "city", labelText: "市区町村" })).value, "港区");
{
  const r = roleVal(meta({ name: "addr_town", labelText: "番地建物" }));
  eq("番地建物 role", r.role, "address_town");
  eq("番地建物 value", r.value, "東新橋2丁目11-7 住友東新橋ビル5号館3階");
}
eq("建物単独 role", roleVal(meta({ name: "bldg", labelText: "建物名" })).role, "address_building");
eq("建物単独 value", roleVal(meta({ name: "bldg", labelText: "建物名" })).value, "住友東新橋ビル5号館3階");

console.log("\n=== 会社名フリガナ → company_kana (htm-consul) ===");
eq("貴社名フリガナ role", detectFieldRole(meta({ name: "kana01", labelText: "貴社名フリガナ" })), "company_kana");
eq("お名前フリガナ → person", detectFieldRole(meta({ name: "kana02", labelText: "お名前フリガナ" })) === "company_kana", false);

console.log("\n=== 連番サフィックス姓名 (shiseido cu_name1/2, cu_ename1/2) ===");
eq("cu_name1 → person_last", detectFieldRole(meta({ name: "cu_name1", labelText: "お名前（漢字）" })), "person_last");
eq("cu_name2 → person_first", detectFieldRole(meta({ name: "cu_name2", labelText: "お名前（漢字）" })), "person_first");
eq("cu_ename1 → hiragana_last", detectFieldRole(meta({ name: "cu_ename1", labelText: "お名前（かな）" })), "person_hiragana_last");
eq("cu_ename2 → hiragana_first", detectFieldRole(meta({ name: "cu_ename2", labelText: "お名前（かな）" })), "person_hiragana_first");
eq("company_name1 not person_last", detectFieldRole(meta({ name: "company_name1" })) === "person_last", false);

console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "💥 FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
