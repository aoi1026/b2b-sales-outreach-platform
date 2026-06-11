import Anthropic from "@anthropic-ai/sdk";

// 失敗したフォームを Claude に解析させ、構造化された送信プラン（どの項目に何を入れ、
// どのボタンをどの順で押し、何をもって成功とするか）を生成する。
// ANTHROPIC_API_KEY が無ければ無効 (null を返す)。

// フォーム項目→送信プランの生成は構造化抽出タスクで Opus は過剰。Haiku で十分かつ
// コストは約 1/15。これにより少額のクレジットでも多数のフォームを処理できる。
const MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env["ANTHROPIC_API_KEY"]) return null;
  if (!client) client = new Anthropic();
  return client;
}

// ページから抽出する1項目分のメタ情報。
export type FieldDescriptor = {
  tag: string; // input / select / textarea
  type: string; // text / email / tel / radio / checkbox / select-one ...
  name: string;
  id: string;
  placeholder: string;
  label: string;
  autocomplete: string;
  dataColumn: string;
  required: boolean;
  // select / radio / checkbox の選択肢 (value とテキスト)
  options?: { value: string; text: string }[];
};

export type ButtonDescriptor = {
  tag: string;
  type: string;
  name: string;
  id: string;
  text: string;
  value: string;
};

// 送信に使う値 (送信元テンプレート + 本文)。
export type FillValues = {
  company?: string | null;
  personName?: string | null;
  personHiragana?: string | null;
  personKatakana?: string | null;
  email?: string | null;
  phone?: string | null;
  postalCode?: string | null;
  address?: string | null;
  url?: string | null;
  subject?: string | null;
  message?: string | null;
  position?: string | null;
};

export type FillAction = {
  selector: string; // CSS セレクタ (#id / [name="..."] を優先)
  action: "fill" | "select" | "check" | "click";
  value: string; // fill/select の入力値。check/click では "" 可
};

export type FillPlan = {
  fills: FillAction[];
  submitSelectors: string[]; // 押す順に並べた送信/確認ボタンのセレクタ
  successText: string; // 成功と判定できる文言 (空文字なら不明)
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          selector: { type: "string" },
          action: { type: "string", enum: ["fill", "select", "check", "click"] },
          value: { type: "string" },
        },
        required: ["selector", "action", "value"],
      },
    },
    submitSelectors: { type: "array", items: { type: "string" } },
    successText: { type: "string" },
  },
  required: ["fills", "submitSelectors", "successText"],
} as const;

const SYSTEM_PROMPT = `あなたは日本語のお問い合わせフォーム自動送信エージェントの解析担当です。
与えられたフォームの項目一覧・ボタン一覧・スクリーンショットと、送信に使う値をもとに、
このフォームを正しく入力して送信するための「実行プラン」を JSON で出力してください。

ルール:
- fills には、入力すべき項目だけを列挙する。不要・無関係な項目は含めない。
- selector は壊れにくいものを選ぶ。優先順位: #id → [name="..."] → 安定した属性セレクタ。
- 値は与えられた values の該当データを使う。存在しない値の項目は入力しない。
- 分割入力欄に注意する:
  - 郵便番号が2つの input に分かれている場合は、postalCode を 3桁/4桁 に分けて順番に fill する。
  - 電話番号が2〜3個の input に分かれている場合は、phone を 分けて順番に fill する。
    各 input の maxlength を見て桁数を合わせる (例: maxlength=2/4/4 なら 2-4-4、3/4/4 なら 3-4-4)。
  - 氏名が姓 (lastName/sei/姓) と名 (firstName/mei/名) に分かれている場合は、
    与えられた氏名を姓と名に分割して順番に fill する。空白があれば空白位置で、
    無ければ自然な位置でおおよそ半分に分割する。
  - 文字種を必ず合わせる: 漢字欄には漢字氏名 (personName)、ひらがな欄には personHiragana、
    カタカナ欄には personKatakana を入れる。プレースホルダが「せい/めい」ならひらがな、
    「セイ/メイ」ならカタカナを要求している。フリガナ欄が姓/名に分かれている場合も
    上記と同様に分割する。
- メールアドレス確認欄 (email2 / mail_confirm 等) には email と同じ値を fill する。
- 文字種の指定 (全角/半角) を守る。ラベルやプレースホルダ・スクリーンショットに「全角」と
  ある欄 (氏名・フリガナ・住所など) は、半角スペース・半角英数・半角記号をすべて全角に変換して
  入力する (例: 住所の半角スペースやカンマは全角に)。逆に「半角」指定 (メール・電話・郵便番号・
  URL) は半角のまま入力する。
- select は action "select"、value には option の value か表示テキストを入れる。
  内容に合致する選択肢があればそれを、無ければ先頭はプレースホルダ (「選択してください」等) の
  ことが多いので 2 番目の option を選ぶ。
- ラジオ/チェックボックス (お問い合わせ種別、個人/法人、プライバシーポリシー同意など) で
  有効化が必要なものは action "check"。表示が CSS で隠れている場合に備え、必要なら対応する
  label のセレクタを使った action "click" でもよい。
- 同意・承諾チェックボックスは必ず check する。name/id に agree / accept / consent を含むもの
  (例: name="acceptance-383") や、ラベルに「同意」「承諾」「プライバシー」「利用規約」を含むものが該当。
- submitSelectors には、送信を完了させるために押すボタンを「押す順」に並べる。
  確認画面を挟むフォーム (submitConfirm → submitSend、確認する → 送信する 等) では両方を順に入れる。
- successText には、送信成功時に画面へ表示されると予想される文言を入れる
  (例: "送信が完了しました" / "お問い合わせを受け付けました" / "ありがとうございました")。不明なら空文字。
- 出力は指定スキーマの JSON のみ。`;

function valuesToText(v: FillValues): string {
  const rows: string[] = [];
  const push = (k: string, val: string | null | undefined) => {
    if (val) rows.push(`${k}: ${val}`);
  };
  push("会社名 (company)", v.company);
  push("氏名 (personName)", v.personName);
  push("氏名ひらがな (personHiragana)", v.personHiragana);
  push("氏名カタカナ (personKatakana)", v.personKatakana);
  push("メールアドレス (email)", v.email);
  push("電話番号 (phone)", v.phone);
  push("郵便番号 (postalCode)", v.postalCode);
  push("住所 (address)", v.address);
  push("URL (url)", v.url);
  push("件名 (subject)", v.subject);
  push("本文 (message)", v.message);
  push("役職 (position)", v.position);
  return rows.join("\n");
}

/**
 * フォームのスナップショット + 値 + スクリーンショットから送信プランを生成する。
 * API キー未設定・解析失敗時は null。
 */
export async function generateFillPlan(args: {
  url: string;
  fields: FieldDescriptor[];
  buttons: ButtonDescriptor[];
  values: FillValues;
  screenshotPng?: Buffer;
}): Promise<FillPlan | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const userContent: Anthropic.ContentBlockParam[] = [];
  if (args.screenshotPng) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: args.screenshotPng.toString("base64"),
      },
    });
  }
  userContent.push({
    type: "text",
    text: [
      `URL: ${args.url}`,
      "",
      "## 入力に使う値",
      valuesToText(args.values) || "(なし)",
      "",
      "## フォーム項目 (JSON)",
      JSON.stringify(args.fields),
      "",
      "## ボタン一覧 (JSON)",
      JSON.stringify(args.buttons),
    ].join("\n"),
  });

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: PLAN_SCHEMA },
      },
      // システム指示は全社で共通なのでキャッシュ対象にする。
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
    });

    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    const plan = JSON.parse(textBlock.text) as FillPlan;
    if (!Array.isArray(plan.fills) || !Array.isArray(plan.submitSelectors)) return null;
    return plan;
  } catch (err) {
    console.warn("[ai-form-analyzer] plan generation failed:", (err as Error).message ?? err);
    return null;
  }
}
