import { chromium, type Browser, type Page, type ElementHandle } from "playwright";
import type { FormInput, SubmitResult } from "./types.ts";

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    // ローカルで挙動を目視確認したい場合は WORKER_HEADED=true で起動 (ブラウザ画面が開く)。
    // 任意で WORKER_SLOWMO=300 のようにミリ秒指定すると操作の間に遅延が入って見やすい。
    // 本番 (Railway 等の Linux コンテナ) は未設定なので headless: true で動く。
    const headed = process.env["WORKER_HEADED"] === "true";
    const slowMoEnv = process.env["WORKER_SLOWMO"];
    const slowMo = slowMoEnv ? Number(slowMoEnv) : undefined;
    browserInstance = await chromium.launch({
      headless: !headed,
      ...(slowMo && Number.isFinite(slowMo) ? { slowMo } : {}),
    });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

type FieldRole =
  | "email"
  | "phone"
  | "postal_code"
  | "subject"
  | "message"
  | "position"
  | "company"
  | "company_kana"
  | "person"
  | "person_kana"
  | "person_hiragana"
  | "person_last"
  | "person_first"
  | null;

const NAV_TIMEOUT = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 MVPBusinessMessage/0.1";

// required を満たすためのフォールバック日本語
const REQUIRED_FALLBACK_TEXT = "問い合わせ";

// ============= Form picker =============

async function scoreForm(form: ElementHandle<Element>): Promise<number> {
  const inputCount = await form.$$eval(
    "input, textarea, select",
    (els) => els.length,
  );
  const hasTextarea = (await form.$$("textarea")).length;
  const hasEmail = (await form.$$("input[type=email]")).length;
  return inputCount + hasTextarea * 2 + hasEmail * 3;
}

async function pickBestForm(
  page: Page,
): Promise<ElementHandle<Element> | null> {
  const forms = await page.$$("form");
  if (forms.length === 0) return null;
  let best: ElementHandle<Element> | null = null;
  let bestScore = -1;
  for (const f of forms) {
    const s = await scoreForm(f);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return bestScore >= 2 ? best : null;
}

// ============= Element metadata =============

async function getElementMeta(page: Page, el: ElementHandle<Element>) {
  const name = (await el.getAttribute("name")) ?? "";
  const id = (await el.getAttribute("id")) ?? "";
  const placeholder = (await el.getAttribute("placeholder")) ?? "";
  const type = ((await el.getAttribute("type")) ?? "").toLowerCase();
  const required = (await el.getAttribute("required")) !== null;
  const tagName = (await el.evaluate((n) => n.tagName.toLowerCase())) as string;

  let labelText = "";
  if (id) {
    labelText = await page.evaluate((idVal: string) => {
      const lbl = document.querySelector(`label[for="${CSS.escape(idVal)}"]`);
      return lbl?.textContent ?? "";
    }, id);
  }
  if (!labelText) {
    labelText = await el.evaluate((node) => {
      const lbl = node.closest("label");
      return lbl?.textContent ?? "";
    });
  }

  return {
    name,
    id,
    placeholder,
    type,
    required,
    tagName,
    labelText,
    idLower: id.toLowerCase(),
    nameLower: name.toLowerCase(),
    combined: [name, id, placeholder, labelText, type].join("|").toLowerCase(),
  };
}

type ElementMeta = Awaited<ReturnType<typeof getElementMeta>>;

// ============= Field role detection =============

function detectFieldRole(meta: ElementMeta): FieldRole {
  const { tagName, type, idLower, nameLower, combined } = meta;
  const idOrName = `${idLower}|${nameLower}`;

  // <textarea> 要素は常に本文
  if (tagName === "textarea") return "message";

  // type 属性によるハードな決定 (最優先)
  if (type === "email") return "email";
  if (type === "tel") return "phone";

  // ====== id/name の specific patterns (ユーザ要件) ======

  // ひらがな (id/name に hira/hiragana/ひらがな)
  if (/hira(?:gana)?|ひらがな/.test(idOrName)) {
    return "person_hiragana";
  }

  // カタカナ・フリガナ (会社用と氏名用を区別)
  if (/katakana|(?:furi)?gana|^kana$|_kana|kana_|フリガナ|フリ|カナ|カタカナ/.test(idOrName)) {
    if (/comp|coop|kaisha|company/.test(idOrName)) return "company_kana";
    return "person_kana";
  }

  // 会社名: coop_name / company_name / company
  if (/coop_name|company_name|^company$|_company$|company_/.test(idOrName))
    return "company";

  // 担当者氏名 (cp_name)
  if (/cp_name/.test(idOrName)) return "person";

  // 姓・名 (last_name/first_name とその variants)
  if (/(?:^|_|-)last[_\-]?name|lastname|sei|family[_\-]?name/.test(idOrName))
    return "person_last";
  if (/(?:^|_|-)first[_\-]?name|firstname|^mei$|_mei|given[_\-]?name/.test(idOrName))
    return "person_first";

  // メール
  if (/email|e[_\-]?mail|^mail$|_mail/.test(idOrName)) return "email";

  // 電話
  if (/^tel$|_tel|phone|denwa/.test(idOrName)) return "phone";

  // 郵便番号 (分割欄で埋まっていない場合の単一 input 用フォールバック)
  if (/zip|postal|yubin|郵便/.test(idOrName)) return "postal_code";

  // 役職 (常に "担当者" 固定)
  if (/^position$|_position|position_|yakushoku|役職/.test(idOrName))
    return "position";

  // 件名
  if (/^subject$|_subject|title|kenmei|件名/.test(idOrName)) return "subject";

  // ====== ここまでで決まらなければ <label>/placeholder 等のヒューリスティック ======
  if (/メール|mail|e-?mail/.test(combined)) return "email";
  if (/電話|phone|tel/.test(combined)) return "phone";
  if (/件名|タイトル|subject|title/.test(combined)) return "subject";
  if (/会社|法人|団体|company|organization|organisation/.test(combined))
    return "company";
  if (/フリガナ|ふりがな|カナ|kana/.test(combined)) return "person_kana";
  if (/役職|position/.test(combined)) return "position";
  if (/問い?合わ?せ|内容|message|comment|inquiry|body|質問|相談/.test(combined))
    return "message";
  if (/氏名|お名前|担当者|氏|name/.test(combined)) return "person";

  return null;
}

// ============= Value selection =============

function pickValueForRole(role: FieldRole, input: FormInput): string | null {
  if (!role) return null;
  switch (role) {
    case "email":
      return input.email ?? null;
    case "phone":
      return input.phone ?? null;
    case "postal_code":
      return input.postalCode ?? null;
    case "subject":
      return input.subject ?? null;
    case "message":
      return input.message ?? null;
    case "position":
      return input.position ?? "担当者";
    case "company":
      return input.company ?? null;
    case "company_kana":
      // 専用 kana が無ければ会社名そのまま (バリデーションで弾かれる可能性あり)
      return input.companyKana ?? input.company ?? null;
    case "person":
      return input.person ?? null;
    case "person_kana":
      // 専用カタカナがあればそれ、無ければ汎用 personKana、最後に漢字氏名
      return input.personKatakana ?? input.personKana ?? input.person ?? null;
    case "person_hiragana":
      return input.personHiragana ?? input.person ?? null;
    case "person_last":
      return input.personLast ?? input.person ?? null;
    case "person_first":
      return input.personFirst ?? null;
    default:
      return null;
  }
}

async function safeFill(el: ElementHandle<Element>, value: string): Promise<boolean> {
  try {
    await el.fill(value);
    return true;
  } catch {
    return false;
  }
}

// ============= Phone / Postal split =============

// 電話を [前,中,後] に分割。ハイフン区切り 3 分割があればそれを優先、無ければ
// 数字のみ抽出して 2-4-4 で切る (ユーザ要件)。
function splitPhoneNumber(phone: string): [string, string, string] {
  const hyphenated = phone.split(/[-ー‐−–—]/).map((s) => s.trim()).filter(Boolean);
  if (hyphenated.length === 3) {
    return [hyphenated[0]!, hyphenated[1]!, hyphenated[2]!];
  }
  const digits = phone.replace(/\D/g, "");
  return [digits.slice(0, 2), digits.slice(2, 6), digits.slice(6, 10)];
}

// 郵便番号を [前,後] に分割。ハイフン区切り 2 分割があればそれを優先、無ければ 3-4。
function splitPostalCode(postal: string): [string, string] {
  const hyphenated = postal.split(/[-ー‐−–—]/).map((s) => s.trim()).filter(Boolean);
  if (hyphenated.length === 2) {
    return [hyphenated[0]!, hyphenated[1]!];
  }
  const digits = postal.replace(/\D/g, "");
  return [digits.slice(0, 3), digits.slice(3, 7)];
}

// フォーム内の name に "tel" を含む input 要素 (テキスト系のみ) を順序通り取得
async function findGroupedInputs(
  form: ElementHandle<Element>,
  pattern: RegExp,
): Promise<ElementHandle<Element>[]> {
  const all = await form.$$("input");
  const matched: ElementHandle<Element>[] = [];
  for (const el of all) {
    const type = ((await el.getAttribute("type")) ?? "text").toLowerCase();
    if (SKIP_INPUT_TYPES.has(type)) continue;
    const name = ((await el.getAttribute("name")) ?? "").toLowerCase();
    if (pattern.test(name)) matched.push(el);
  }
  return matched;
}

// 戻り値: 充填済みの name 属性集合 (後段の通常フィルで再度埋めないために使う)
async function fillSplitGroups(
  form: ElementHandle<Element>,
  input: FormInput,
): Promise<Set<string>> {
  const consumedNames = new Set<string>();

  const remember = async (el: ElementHandle<Element>) => {
    const name = (await el.getAttribute("name")) ?? "";
    if (name) consumedNames.add(name);
  };

  // tel × 3 → 2-4-4 で分割充填
  const telInputs = await findGroupedInputs(form, /tel/);
  if (telInputs.length === 3 && input.phone) {
    const [a, b, c] = splitPhoneNumber(input.phone);
    if (a) await safeFill(telInputs[0]!, a);
    if (b) await safeFill(telInputs[1]!, b);
    if (c) await safeFill(telInputs[2]!, c);
    for (const el of telInputs) await remember(el);
  }

  // zip / postal × 2 → 3-4 で分割充填
  const zipInputs = await findGroupedInputs(form, /zip|postal|yubin|郵便/);
  if (zipInputs.length === 2 && input.postalCode) {
    const [a, b] = splitPostalCode(input.postalCode);
    if (a) await safeFill(zipInputs[0]!, a);
    if (b) await safeFill(zipInputs[1]!, b);
    for (const el of zipInputs) await remember(el);
  }

  return consumedNames;
}

// ============= Select handling =============

// <select> 要素は2番目以降の <option> を選択 (1番目はプレースホルダー想定)
async function processSelects(form: ElementHandle<Element>): Promise<void> {
  const selects = await form.$$("select");
  for (const sel of selects) {
    try {
      const optionValues = await sel.$$eval("option", (opts) =>
        (opts as HTMLOptionElement[]).map((o) => o.value),
      );
      // 2番目以降のうち、空でない最初の値を選ぶ
      const target = optionValues.slice(1).find((v) => v && v.trim() !== "");
      if (target !== undefined) {
        await sel.selectOption(target);
      } else if (optionValues.length >= 1 && optionValues[0]) {
        // 全て空なら最初の値
        await sel.selectOption(optionValues[0]);
      }
    } catch {
      /* ignore */
    }
  }
}

// ============= Text-like field filling (input + textarea) =============

const SKIP_INPUT_TYPES = new Set([
  "submit",
  "button",
  "hidden",
  "checkbox",
  "radio",
  "file",
  "image",
  "reset",
]);

async function fillTextLikeFields(
  page: Page,
  form: ElementHandle<Element>,
  input: FormInput,
  consumedNames: Set<string>,
): Promise<number> {
  const elements = await form.$$("input, textarea");
  let filled = 0;

  for (const el of elements) {
    const meta = await getElementMeta(page, el);

    // <input> でテキスト系以外 (submit/checkbox/radio など) はここでは触らない
    if (meta.tagName === "input" && SKIP_INPUT_TYPES.has(meta.type)) continue;

    // 既に分割グループ (tel×3 / zip×2) で埋め済みの name はスキップ
    if (meta.name && consumedNames.has(meta.name)) continue;

    const role = detectFieldRole(meta);
    let value = pickValueForRole(role, input);

    // role が決まらない & required 属性 → required を満たすデフォルトで埋める
    if ((!value || value === "") && meta.required) {
      value =
        meta.tagName === "textarea"
          ? input.message ?? REQUIRED_FALLBACK_TEXT
          : REQUIRED_FALLBACK_TEXT;
    }

    if (value === undefined || value === null || value === "") continue;

    const ok = await safeFill(el, value);
    if (ok) filled++;
  }

  return filled;
}

// ============= Checkbox handling =============

async function processCheckboxes(form: ElementHandle<Element>): Promise<void> {
  const checkboxes = await form.$$('input[type="checkbox"]');
  if (checkboxes.length === 0) return;

  // (1) id/name に "agree" 等 を含むものは無条件にチェック
  // (2) それ以外は name 属性でグループ化し、各グループの先頭をチェック
  const groupByName = new Map<string, ElementHandle<Element>[]>();

  for (const cb of checkboxes) {
    const id = ((await cb.getAttribute("id")) ?? "").toLowerCase();
    const name = ((await cb.getAttribute("name")) ?? "").toLowerCase();
    const isAgree = /agree|同意|承諾|consent|terms|privacy/.test(`${id}|${name}`);

    if (isAgree) {
      try {
        await cb.check({ force: true });
      } catch {
        /* ignore */
      }
      continue;
    }

    const key = name || `__${groupByName.size}`;
    const list = groupByName.get(key) ?? [];
    list.push(cb);
    groupByName.set(key, list);
  }

  // 並んでいる checkbox 群 (= 同じ name) の先頭を選択
  for (const list of groupByName.values()) {
    if (list.length === 0) continue;
    if (list.length >= 2) {
      try {
        await list[0]!.check({ force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// ============= Required field final validation =============
// Step 4〜7 の後に呼ばれ、required 属性付きで未充填の要素を検出して
// 適切なデフォルトで埋める「最終セーフティネット」。

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function ensureAllRequiredFilled(
  page: Page,
  form: ElementHandle<Element>,
  input: FormInput,
): Promise<void> {
  const requiredEls = await form.$$("[required]");

  for (const el of requiredEls) {
    const tagName = (await el.evaluate((n) => n.tagName.toLowerCase())) as string;
    const type = ((await el.getAttribute("type")) ?? "").toLowerCase();

    try {
      // ----- <select> -----
      if (tagName === "select") {
        const value = await el.evaluate((n) => (n as HTMLSelectElement).value);
        if (!value || value.trim() === "") {
          // processSelects と同じロジック (2番目以降の有効値)
          const optionValues = await el.$$eval("option", (opts) =>
            (opts as HTMLOptionElement[]).map((o) => o.value),
          );
          const target =
            optionValues.slice(1).find((v) => v && v.trim() !== "") ??
            optionValues[0];
          if (target) {
            // selectOption は ElementHandle が select でなければ失敗するので caller でラップ
            await (el as ElementHandle<HTMLSelectElement>).selectOption(target);
          }
        }
        continue;
      }

      // ----- input[type=checkbox] -----
      if (tagName === "input" && type === "checkbox") {
        const checked = await (el as ElementHandle<HTMLInputElement>).isChecked();
        if (!checked) {
          await (el as ElementHandle<HTMLInputElement>).check({ force: true });
        }
        continue;
      }

      // ----- input[type=radio] -----
      if (tagName === "input" && type === "radio") {
        const name = (await el.getAttribute("name")) ?? "";
        if (name) {
          // 同じ name グループのうち1つでも checked なら何もしない
          const anyChecked = await form.$$eval(
            `input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`,
            (radios) => (radios as HTMLInputElement[]).some((r) => r.checked),
          );
          if (!anyChecked) {
            await (el as ElementHandle<HTMLInputElement>).check({ force: true });
          }
        } else {
          await (el as ElementHandle<HTMLInputElement>).check({ force: true });
        }
        continue;
      }

      // ----- input[type=date] -----
      if (tagName === "input" && type === "date") {
        const value = await (el as ElementHandle<HTMLInputElement>).inputValue();
        if (!value || value.trim() === "") {
          await (el as ElementHandle<HTMLInputElement>).fill(todayYmd());
        }
        continue;
      }

      // ----- input[type=number] / time / datetime-local 等 -----
      if (tagName === "input" && (type === "number" || type === "time" || type === "datetime-local")) {
        const value = await (el as ElementHandle<HTMLInputElement>).inputValue();
        if (!value || value.trim() === "") {
          const fallback =
            type === "number"
              ? "1"
              : type === "time"
                ? "10:00"
                : `${todayYmd()}T10:00`;
          await (el as ElementHandle<HTMLInputElement>).fill(fallback);
        }
        continue;
      }

      // ----- text-like (input + textarea) -----
      if (tagName === "textarea" || (tagName === "input" && !SKIP_INPUT_TYPES.has(type))) {
        const value = await (el as ElementHandle<HTMLInputElement>).inputValue();
        if (!value || value.trim() === "") {
          // まずは正規の役割検出を試す (今まで未マッチだったが補えるかも)
          const meta = await getElementMeta(page, el);
          const role = detectFieldRole(meta);
          let val = pickValueForRole(role, input);
          if (!val) {
            val = tagName === "textarea"
              ? (input.message ?? REQUIRED_FALLBACK_TEXT)
              : REQUIRED_FALLBACK_TEXT;
          }
          await safeFill(el, val);
        }
      }
    } catch {
      /* 個別要素の失敗は無視。可能な限り進める */
    }
  }
}

// フォーム内に checkbox が1つでもあって、まだ何もチェックされていなければ先頭をチェック。
// (processCheckboxes は agree 系か "name 同一が2個以上" でしかチェックしないため、
//  単独 checkbox が必須なケースを救う)
async function ensureAtLeastOneCheckboxChecked(
  form: ElementHandle<Element>,
): Promise<void> {
  const checkboxes = await form.$$('input[type="checkbox"]');
  if (checkboxes.length === 0) return;
  const anyChecked = await form.$$eval(
    'input[type="checkbox"]',
    (els) => (els as HTMLInputElement[]).some((cb) => cb.checked),
  );
  if (!anyChecked) {
    try {
      await (checkboxes[0] as ElementHandle<HTMLInputElement>).check({ force: true });
    } catch {
      /* ignore */
    }
  }
}

// ============= Radio handling =============

async function processRadios(form: ElementHandle<Element>): Promise<void> {
  const radios = await form.$$('input[type="radio"]');
  if (radios.length === 0) return;

  // name 属性でグループ化し、各グループの先頭を選択
  const groupByName = new Map<string, ElementHandle<Element>[]>();
  for (const r of radios) {
    const name = ((await r.getAttribute("name")) ?? "").toLowerCase();
    const key = name || `__${groupByName.size}`;
    const list = groupByName.get(key) ?? [];
    list.push(r);
    groupByName.set(key, list);
  }

  for (const list of groupByName.values()) {
    if (list.length === 0) continue;
    try {
      await list[0]!.check({ force: true });
    } catch {
      /* ignore */
    }
  }
}

// ============= Submit button =============

async function findSubmitButton(
  form: ElementHandle<Element>,
): Promise<ElementHandle<Element> | null> {
  // 1. type="submit" の input/button
  const typed = await form.$('input[type="submit"], button[type="submit"]');
  if (typed) return typed;

  // 2. name="send" の要素
  const namedSend = await form.$('[name="send"]');
  if (namedSend) return namedSend;

  // 3. name に send/submit/confirm を含む button/input
  const sendLike = await form.$(
    'button[name*="send"], button[name*="submit"], button[name*="confirm"], input[name*="send"], input[name*="submit"], input[name*="confirm"]',
  );
  if (sendLike) return sendLike;

  // 4. テキストに 送信/確認/submit/send を含む button
  const buttons = await form.$$("button");
  for (const b of buttons) {
    const text = ((await b.textContent()) ?? "").toLowerCase().trim();
    if (/送信|確認|submit|send|確定/.test(text)) return b;
  }

  // 5. フォールバック: 最初の button
  return (await form.$("button")) ?? null;
}

// 確認画面用: type="submit" / name="send" の要素のうち、value (または <button> のテキスト) に
// 「送信」を含むもののみを選ぶ。「戻る」ボタンを誤って押さないため value 判定は必須。
async function findConfirmationSendButton(
  page: Page,
): Promise<ElementHandle<Element> | null> {
  const candidates = await page.$$(
    'input[type="submit"], button[type="submit"], [name="send"]',
  );
  if (candidates.length === 0) return null;

  for (const el of candidates) {
    // <input type="submit"> は value 属性に表示文字が入る
    const value = (await el.getAttribute("value")) ?? "";
    if (/送信/.test(value)) return el;

    // <button>送信する</button> 形式は value 属性が無いのでテキストを見る
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    if (tag === "button") {
      const text = ((await el.textContent()) ?? "").trim();
      if (/送信/.test(text)) return el;
    }
  }
  return null;
}

// 最終確認ボタン: id または name が "submit" の要素のうち、
// value/表示テキストに "Send Message" または "送信" を含むものを選ぶ。
async function findFinalSubmitButton(
  page: Page,
): Promise<ElementHandle<Element> | null> {
  const candidates = await page.$$('[id="submit"], [name="submit"]');
  if (candidates.length === 0) return null;

  for (const el of candidates) {
    const value = (await el.getAttribute("value")) ?? "";
    const text = ((await el.textContent()) ?? "").trim();
    if (/Send\s*Message|送信/i.test(value) || /Send\s*Message|送信/i.test(text)) {
      return el;
    }
  }
  return null;
}

// ============= Success / error detection =============

const SUCCESS_PATTERNS = [
  /送信完了/,
  /送信され/,
  /受け付け/,
  /ありがとうござい/,
  /thank\s*you/i,
  /successfully/i,
  /submitted/i,
  /completed/i,
];

const ERROR_PATTERNS = [
  /入力エラー/,
  /必須項目/,
  /入力して.*くだ/,
  /入力内容.*誤/,
  /error/i,
  /invalid/i,
];

function isSuccessContent(content: string): boolean {
  return SUCCESS_PATTERNS.some((p) => p.test(content));
}
function isErrorContent(content: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(content));
}

// ============= Main =============

export async function submitForm(
  formUrl: string,
  input: FormInput,
): Promise<SubmitResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    const response = await page.goto(formUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    const httpStatus = response?.status() ?? 0;
    if (httpStatus >= 400) {
      return {
        status: "failed",
        errorType: "NETWORK_ERROR",
        errorMessage: `HTTP ${httpStatus}`,
        httpStatus,
      };
    }

    const form = await pickBestForm(page);
    if (!form) {
      return {
        status: "failed",
        errorType: "FORM_NOT_FOUND",
        errorMessage: "送信可能なフォームを検出できませんでした。",
        httpStatus,
      };
    }

    // 1) tel × 3 / zip × 2 のような分割入力欄を先に埋める (ユーザ要件)
    const consumedNames = await fillSplitGroups(form, input);

    // 2) 通常のテキスト/textarea/email/tel フィールドを埋める
    const filled = await fillTextLikeFields(page, form, input, consumedNames);
    if (filled === 0 && consumedNames.size === 0) {
      return {
        status: "failed",
        errorType: "FIELD_MISMATCH",
        errorMessage: "フォーム項目にマッピングできませんでした。",
        httpStatus,
      };
    }

    // 3) <select>, checkbox, radio を処理
    await processSelects(form);
    await processCheckboxes(form);
    await processRadios(form);

    // 4) 最終セーフティネット: required 属性付きで未充填の要素をすべて埋める
    //    (input/textarea/checkbox/radio/select/date/number 等を網羅)
    await ensureAllRequiredFilled(page, form, input);
    // checkbox が1つもチェックされていなければ先頭をチェック (必須同意ボックス対策)
    await ensureAtLeastOneCheckboxChecked(form);

    const submitBtn = await findSubmitButton(form);
    if (!submitBtn) {
      return {
        status: "failed",
        errorType: "SUBMIT_FAILED",
        errorMessage: "送信ボタンが見つかりませんでした。",
        httpStatus,
      };
    }

    const urlBefore = page.url();
    await Promise.all([
      page
        .waitForLoadState("networkidle", { timeout: NAV_TIMEOUT })
        .catch(() => null),
      submitBtn.click({ timeout: NAV_TIMEOUT }),
    ]);

    // 確認画面が出るタイプのフォーム対策:
    // 次ページに「送信」value/text を持つ submit/name=send があれば、もう一度クリック
    const confirmBtn = await findConfirmationSendButton(page);
    if (confirmBtn) {
      await Promise.all([
        page
          .waitForLoadState("networkidle", { timeout: NAV_TIMEOUT })
          .catch(() => null),
        confirmBtn.click({ timeout: NAV_TIMEOUT }),
      ]);
    }

    // 更に id/name="submit" を持ち value/text に "Send Message"/"送信" を含む要素があれば
    // 最終確認としてもう一度クリック (3段階目)
    const finalBtn = await findFinalSubmitButton(page);
    if (finalBtn) {
      await Promise.all([
        page
          .waitForLoadState("networkidle", { timeout: NAV_TIMEOUT })
          .catch(() => null),
        finalBtn.click({ timeout: NAV_TIMEOUT }),
      ]);
    }

    const urlAfter = page.url();
    const content = await page.content().catch(() => "");

    if (isSuccessContent(content)) return { status: "success", httpStatus };
    if (urlBefore !== urlAfter && !isErrorContent(content))
      return { status: "success", httpStatus };

    if (isErrorContent(content))
      return {
        status: "failed",
        errorType: "VALIDATION_ERROR",
        errorMessage: "バリデーションエラーと思われる応答を検出しました。",
        httpStatus,
      };

    return {
      status: "failed",
      errorType: "UNKNOWN",
      errorMessage: "送信後のページが成功と判定できませんでした。",
      httpStatus,
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") {
      return {
        status: "failed",
        errorType: "TIMEOUT",
        errorMessage: err.message,
      };
    }
    return {
      status: "failed",
      errorType: "UNKNOWN",
      errorMessage: err.message || String(e),
    };
  } finally {
    await page.close().catch(() => null);
    await context.close().catch(() => null);
  }
}
