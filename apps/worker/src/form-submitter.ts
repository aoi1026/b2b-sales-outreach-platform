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
  | "email_confirm"
  | "phone"
  | "fax"
  | "postal_code"
  | "subject"
  | "message"
  | "position"
  | "company"
  | "company_kana"
  | "url"
  | "address"
  | "address_city"
  | "address_town"
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
  let best: ElementHandle<Element> | null = null;
  let bestScore = -1;

  // 1. <form> 要素を最優先
  const forms = await page.$$("form");
  for (const f of forms) {
    const s = await scoreForm(f);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  // 強いスコアの <form> が見つかれば即採用 (div fallback で乗っ取られるのを防ぐ)
  if (best && bestScore >= 5) return best;

  // 2. フォールバック: class に form_body / contact-form / mail-form 等を含む
  //    <div> / <section> / [role="form"] (<form> タグを使わない SPA 対策)
  const divCandidates = await page.$$(
    [
      'div[class*="form_body"]',
      'div[class*="form-body"]',
      'div[class*="formBody"]',
      'div[class*="form_wrap"]',
      'div[class*="form-wrap"]',
      'div[class*="form_inner"]',
      'div[class*="form-inner"]',
      'div[class*="contact_form"]',
      'div[class*="contact-form"]',
      'div[class*="contactForm"]',
      'div[class*="contact_box"]',
      'div[class*="contact-box"]',
      'div[class*="inquiry"]',
      'div[class*="mailform"]',
      'div[class*="mail-form"]',
      'div[class*="mail_form"]',
      'div[class*="wpcf7"]',
      'div[class*="mw_wp_form"]',
      'div[class*="gform"]',
      'div[class*="gform_wrapper"]',
      'div[class*="hs-form"]',
      'div[class*="hsForm"]',
      'div[class*="p-form"]',
      'div[class*="p-main_form"]',
      'div[class*="p_main_form"]',
      'div[class*="p-contact"]',
      'div[class*="satori"]',
      'form[class*="wpcf7-form"]',
      'div[id*="form"]',
      'div[id*="contact"]',
      'div[id*="inquiry"]',
      'section[class*="form"]',
      'section[class*="contact"]',
      'section[class*="inquiry"]',
      '[role="form"]',
      'main [class*="form"]',
      'article [class*="form"]',
    ].join(","),
  );
  for (const d of divCandidates) {
    const s = await scoreForm(d);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  // 入力欄が2つ以上 (textarea で score=2 でも可) ある時点で採用
  if (best && bestScore >= 2) return best;

  // 3. <form> がスコア1でも採用 (極小フォーム救済)
  if (best && bestScore >= 1) return best;

  // 4. 最終フォールバック: ページ全体に textarea+メールが揃っているなら body をスコープに使う
  //    (SPA で form タグもラッパーも無いケース)
  const body = await page.$("body");
  if (body) {
    const bodyScore = await scoreForm(body);
    if (bodyScore >= 3) return body;
  }

  return null;
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
  if (type === "email") {
    // メール確認欄 (確認用 / もう一度 / 再入力) は別ロール
    if (/confirm|conf|verify|verif|check|re[_\-]?mail|mail2|email2|再|もう一度|確認/.test(idOrName + "|" + combined))
      return "email_confirm";
    return "email";
  }
  if (type === "tel") {
    if (/fax/.test(idOrName + "|" + combined)) return "fax";
    return "phone";
  }
  if (type === "url") return "url";

  // ====== id/name の specific patterns (ユーザ要件) ======

  // ひらがな (id/name に hira/hiragana/ひらがな、または combined にひらがなヒント)
  if (/hira(?:gana)?|ひらがな/.test(idOrName) || /ひらがな|ふりがな/.test(combined)) {
    return "person_hiragana";
  }

  // カタカナ・フリガナ (会社用と氏名用を区別)
  if (/katakana|(?:furi)?gana|^kana$|_kana|kana_|フリガナ|フリ|カナ|カタカナ/.test(idOrName)) {
    if (/comp|coop|kaisha|company|corp|firm/.test(idOrName)) return "company_kana";
    // combined に「ひらがな」が含まれていればひらがな扱いに切替 (akita-ya: id=kana だが
    // ラベル/プレースホルダで「ひらがな」を要求するケース)
    if (/ひらがな/.test(combined)) return "person_hiragana";
    return "person_kana";
  }

  // 会社名: coop_name / company_name / company / corporation / 法人
  if (/coop_name|company_name|^company$|_company$|company_|corp(?:oration)?|kaisha|会社|法人|^firm$|_firm/.test(idOrName))
    return "company";

  // 担当者氏名 (cp_name)
  if (/cp_name/.test(idOrName)) return "person";

  // 姓・名 (last_name/first_name とその variants)
  if (/(?:^|_|-)last[_\-]?name|lastname|^sei$|_sei|family[_\-]?name|surname|姓/.test(idOrName))
    return "person_last";
  if (/(?:^|_|-)first[_\-]?name|firstname|^mei$|_mei|given[_\-]?name|名前/.test(idOrName))
    return "person_first";

  // メール確認 (例: email_confirm / mail2 / mail_re / entryMail2 / emailcheck)
  if (
    /(?:e?mail|メール).*(?:confirm|conf|verify|verif|check|2|re|再|確認)|(?:confirm|verify|check|re).*(?:e?mail|メール)|mail_check|mailcheck|emailcheck|mail_re|re_?mail|mail2|email2|entrymail2/.test(
      idOrName,
    )
  )
    return "email_confirm";

  // メール (entryMail1 等 — confirm でない方)
  if (/email|e[_\-]?mail|^mail$|_mail|mail_|メール|entrymail/.test(idOrName)) return "email";

  // FAX
  if (/^fax$|_fax|fax_/.test(idOrName)) return "fax";

  // 電話
  if (/^tel$|_tel|tel_|phone|denwa|電話|telnumber|telno/.test(idOrName)) return "phone";

  // 郵便番号 (分割欄で埋まっていない場合の単一 input 用フォールバック)
  if (/zip|postal|yubin|^post$|_post|郵便/.test(idOrName)) return "postal_code";

  // URL / web
  if (/^url$|_url|url_|website|web_?site|home_?page|hp_?url/.test(idOrName)) return "url";

  // 住所の細分化: city / town / address のいずれかを返す
  // (akita-ya: id=city, id=town, id=pref / chushoku: name=住所)
  if (/^city$|_city|city_|市区町村|市町村/.test(idOrName)) return "address_city";
  if (/^town$|_town|town_|^street$|_street|street_|番地|町名/.test(idOrName))
    return "address_town";
  if (
    /^address$|_address|address_|^addr$|_addr|jusho|住所|prefecture|都道府県|^pref$|_pref|entryaddr/.test(
      idOrName,
    )
  )
    return "address";

  // 役職 (常に "担当者" 固定)
  if (/^position$|_position|position_|yakushoku|役職|busho|部署|department|dept/.test(idOrName))
    return "position";

  // 件名
  if (/^subject$|_subject|subject_|title|kenmei|件名|inquiry_type|inquiry_subject/.test(idOrName)) return "subject";

  // 本文 (id/name レベル)
  if (/^message$|_message|message_|^content$|_content|content_|^inquiry$|inquiry_body|toiawase|お問い?合わ?せ|honbun|本文|comment|^body$|_body/.test(idOrName))
    return "message";

  // 氏名 (id/name レベル — name 属性は紛らわしいので最後の手段)
  if (/^name$|_name|name_|shimei|氏名|お名前|tantousha|担当者/.test(idOrName))
    return "person";

  // ====== ここまでで決まらなければ <label>/placeholder 等のヒューリスティック ======
  if (/メール.*確認|もう一度|再入力|confirm.*mail|mail.*confirm|verify.*email/i.test(combined))
    return "email_confirm";
  if (/メール|mail|e-?mail/.test(combined)) return "email";
  if (/fax|ファクス|ファックス/i.test(combined)) return "fax";
  if (/電話|phone|tel(?:ephone)?|お電話/.test(combined)) return "phone";
  if (/郵便|zip|postal|〒/.test(combined)) return "postal_code";
  if (/url|ホームページ|web\s*site|website/i.test(combined)) return "url";
  if (/住所|address|都道府県|prefecture|市区町村|city/i.test(combined)) return "address";
  if (/件名|タイトル|subject|title|お問い?合わ?せ.*種別|種別/.test(combined)) return "subject";
  if (/会社|法人|団体|company|organization|organisation|corporation/i.test(combined))
    return "company";
  if (/フリガナ|ふりがな|カナ|kana/i.test(combined)) return "person_kana";
  if (/役職|position|部署|department/i.test(combined)) return "position";
  if (/問い?合わ?せ|内容|message|comment|inquiry|body|質問|相談|備考|要望/i.test(combined))
    return "message";
  if (/氏名|お名前|担当者|氏|name/i.test(combined)) return "person";

  return null;
}

// ============= Value selection =============

// カナ系フィールドに渡す前に空白 (半角/全角/タブ) を除去。
// フォームによっては「ヤマダ タロウ」のような空白入りカナを拒否するため。
function stripSpaces(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.replace(/[\s　]+/g, "");
}

function pickValueForRole(role: FieldRole, input: FormInput): string | null {
  if (!role) return null;
  switch (role) {
    case "email":
      return input.email ?? null;
    case "email_confirm":
      // 確認用メール欄: 必ず元のメールと同じ値を入れる (バリデーションで弾かれないため)
      return input.email ?? null;
    case "phone":
      return input.phone ?? null;
    case "fax":
      // FAX 欄は専用値が無いので電話番号で代替 (空のままだと required で弾かれることがある)
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
      // 専用 kana が無ければ会社名そのまま (バリデーションで弾かれる可能性あり)。空白除去。
      return stripSpaces(input.companyKana ?? input.company);
    case "url":
      return input.url ?? null;
    case "address":
      // SenderTemplate.address があればそれを使う。無ければ郵便番号のみ等は使わない
      // (中途半端な住所はバリデーションで弾かれるので空のまま)
      return input.address ?? null;
    case "address_city":
      // 「市区町村」相当: 住所文字列から都道府県を除いた頭の部分を使うのが理想だが、
      // 厳密な分割は難しいので、address があれば最初の 10 文字程度を使う。
      // 無ければ address そのまま (字数オーバーは reject されるリスクあり)。
      return input.address ? input.address.slice(0, 16) : null;
    case "address_town":
      // 「町名・番地」相当: address があれば 10 文字目以降。短ければ address そのまま。
      if (!input.address) return null;
      return input.address.length > 16 ? input.address.slice(16) : input.address;
    case "person":
      return input.person ?? null;
    case "person_kana":
      // 専用カタカナがあればそれ、無ければ汎用 personKana、最後に漢字氏名。空白除去。
      return stripSpaces(input.personKatakana ?? input.personKana ?? input.person);
    case "person_hiragana":
      return stripSpaces(input.personHiragana ?? input.person);
    case "person_last":
      return input.personLast ?? input.person ?? null;
    case "person_first":
      return input.personFirst ?? null;
    default:
      return null;
  }
}

// 表示中のフィールドは type() で人間っぽく打鍵し、input/change/blur を発火。
// display:none / visibility:hidden の場合は type() できないので、
// JS で value をセット + イベント dispatch する hidden-aware ロジックに切り替える。
async function safeFill(
  el: ElementHandle<Element>,
  value: string,
): Promise<boolean> {
  let visible = false;
  try {
    visible = await el.isVisible();
  } catch {
    visible = false;
  }

  if (visible) {
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => null);
      await el.fill("");
      await el.type(value, { delay: 20 });
      await el.evaluate((node) => {
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        node.dispatchEvent(new Event("blur", { bubbles: true }));
      });
      return true;
    } catch {
      /* fall through to hidden path */
    }
  }

  // 非表示要素フォールバック (Satori 等で隠し UI の裏に input が居るケース)
  try {
    await el.evaluate((node, val) => {
      const inp = node as HTMLInputElement | HTMLTextAreaElement;
      inp.value = val;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      inp.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value);
    return true;
  } catch {
    return false;
  }
}

// 非表示 (display:none) のチェックボックス / ラジオを確実にチェックする。
// 戦略: ① 関連 <label for=id> があれば label をクリック (display:none でも label は
// 操作できる) ② それでも checked にならなければ JS で .checked=true + change/click を
// dispatch。Playwright の check({force:true}) は内部で pointer event を要求するため
// 完全な display:none に対しては失敗することがある。
async function checkOrClickLabel(
  el: ElementHandle<Element>,
  page: Page,
): Promise<boolean> {
  // (a) 標準 API でまず試す
  try {
    await (el as ElementHandle<HTMLInputElement>).check({ force: true, timeout: 2_000 });
    const ok = await (el as ElementHandle<HTMLInputElement>).isChecked();
    if (ok) return true;
  } catch {
    /* fall through */
  }

  // (b) <label for="id"> を click (label は display:none でも親が表示されていれば操作可)
  try {
    const id = await el.getAttribute("id");
    if (id) {
      const label = await page.$(`label[for="${id.replace(/"/g, '\\"')}"]`);
      if (label) {
        await label.click({ force: true, timeout: 2_000 }).catch(() => null);
        const ok = await (el as ElementHandle<HTMLInputElement>).isChecked();
        if (ok) return true;
      }
    }
  } catch {
    /* fall through */
  }

  // (c) 親 <label> を click
  try {
    const parentLabel = await el.evaluateHandle((node) => node.closest("label"));
    const labelEl = parentLabel.asElement();
    if (labelEl) {
      await (labelEl as ElementHandle<Element>)
        .click({ force: true, timeout: 2_000 })
        .catch(() => null);
      const ok = await (el as ElementHandle<HTMLInputElement>).isChecked();
      if (ok) return true;
    }
  } catch {
    /* fall through */
  }

  // (d) JS で直接 checked=true + change dispatch
  try {
    await el.evaluate((node) => {
      const inp = node as HTMLInputElement;
      inp.checked = true;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      inp.dispatchEvent(new Event("click", { bubbles: true }));
    });
    return true;
  } catch {
    return false;
  }
}

// ============= Phone / Postal split =============

// 電話を [前,中,後] に分割。ハイフン区切り 3 分割があればそれを優先、
// 無ければ数字のみ抽出して 桁数に応じて分割:
//   - 11 桁 (携帯/IP電話 09X/08X/07X/050) → 3-4-4
//   - 10 桁 (固定電話 03/06=2桁、それ以外=2桁デフォルト) → 2-4-4
//   - その他は最善を尽くす
function splitPhoneNumber(
  phone: string,
  forcedFirstWidth: number | null = null,
): [string, string, string] {
  const hyphenated = phone.split(/[-ー‐−–—]/).map((s) => s.trim()).filter(Boolean);
  // ハイフン区切りで 3 分割があっても、forcedFirstWidth が指定されていれば再分割する
  // (例: maxlength=2 のフォームに 090-1234-5678 を渡すと先頭が溢れるため)
  if (hyphenated.length === 3 && forcedFirstWidth === null) {
    return [hyphenated[0]!, hyphenated[1]!, hyphenated[2]!];
  }
  const digits = phone.replace(/\D/g, "");

  if (forcedFirstWidth === 2) {
    // 2-4-4: 11 桁携帯を入れる場合は先頭1桁が溢れるが、固定書式に合わせる
    return [digits.slice(0, 2), digits.slice(2, 6), digits.slice(6, 10)];
  }
  if (forcedFirstWidth === 3) {
    return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7, 11)];
  }
  // 自動判定: 11 桁は 3-4-4、10 桁以下は 2-4-4
  if (digits.length >= 11) {
    return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7, 11)];
  }
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

  // tel × 3 → 分割充填。最初の入力欄の maxlength を見て 2-4-4 か 3-4-4 を決める。
  //   - maxlength="2" なら 2-4-4 固定 (centralforestgroup の entryPhone1 等)
  //   - maxlength="3" なら 3-4-4 固定
  //   - 指定なしは桁数ベース (splitPhoneNumber デフォルト)
  const telInputs = await findGroupedInputs(
    form,
    /tel|phone|telephone|mobile|携帯|電話/,
  );
  if (telInputs.length === 3 && input.phone) {
    const firstMax = await telInputs[0]!.getAttribute("maxlength");
    const forcedFirstWidth =
      firstMax === "2" ? 2 : firstMax === "3" ? 3 : null;
    const [a, b, c] = splitPhoneNumber(input.phone, forcedFirstWidth);
    if (a) await safeFill(telInputs[0]!, a);
    if (b) await safeFill(telInputs[1]!, b);
    if (c) await safeFill(telInputs[2]!, c);
    for (const el of telInputs) await remember(el);
  }

  // zip / postal × 2 → 3-4 で分割充填
  const zipInputs = await findGroupedInputs(
    form,
    /zip|postal|^post$|post[_-]?\d|yubin|郵便/,
  );
  if (zipInputs.length === 2 && input.postalCode) {
    const [a, b] = splitPostalCode(input.postalCode);
    if (a) await safeFill(zipInputs[0]!, a);
    if (b) await safeFill(zipInputs[1]!, b);
    for (const el of zipInputs) await remember(el);
  }

  return consumedNames;
}

// ============= Select handling =============

// <select> 要素は2番目以降の <option> のうち、value が空でなく disabled でない
// 最初のものを選択する。1 番目は「選択してください」等のプレースホルダー想定。
// すべてが無効なら最後の手段として 1 番目を選ぶ。
async function processSelects(form: ElementHandle<Element>): Promise<void> {
  const selects = await form.$$("select");
  for (const sel of selects) {
    try {
      const options = await sel.$$eval("option", (opts) =>
        (opts as HTMLOptionElement[]).map((o) => ({
          value: o.value,
          disabled: o.disabled,
        })),
      );
      if (options.length === 0) continue;

      // 2 番目以降の有効な option を優先
      const valid = options.find(
        (o, idx) => idx > 0 && o.value.trim() !== "" && !o.disabled,
      );

      if (valid) {
        await sel.selectOption(valid.value);
      } else {
        // 全部 disabled / 空の場合は先頭 (それしか選べない)
        const first = options[0];
        if (first && !first.disabled && first.value.trim() !== "") {
          await sel.selectOption(first.value);
        }
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

async function processCheckboxes(
  page: Page,
  form: ElementHandle<Element>,
): Promise<void> {
  const checkboxes = await form.$$('input[type="checkbox"]');
  if (checkboxes.length === 0) return;

  // 全 checkbox を確実にチェック。display:none の場合は label 経由でクリックする。
  // (Satori の satori__privacy_policy_agreement 等)
  for (const cb of checkboxes) {
    await checkOrClickLabel(cb, page);
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

    // CSRF / nonce / honeypot 等の hidden は絶対に触らない (記事の Fix #6)
    if (tagName === "input" && type === "hidden") continue;

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
          await checkOrClickLabel(el, page);
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
            await checkOrClickLabel(el, page);
          }
        } else {
          await checkOrClickLabel(el, page);
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

// ラベルテキスト経由で「プライバシーポリシー / 利用規約 / 個人情報保護方針 に同意」
// 系のチェックボックスを検出してチェック。id/name に agree が含まれない
// (= processCheckboxes で取りこぼした) ケースを救う。
async function ensureAgreementsChecked(
  page: Page,
  form: ElementHandle<Element>,
): Promise<void> {
  const checkboxes = await form.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      const isChecked = await (cb as ElementHandle<HTMLInputElement>).isChecked();
      if (isChecked) continue;

      // ラベル文字列を組み立てる: <label for=id>, 親<label>, 隣接テキスト
      let labelText = "";
      const id = (await cb.getAttribute("id")) ?? "";
      if (id) {
        labelText = await page.evaluate((idVal: string) => {
          const lbl = document.querySelector(`label[for="${CSS.escape(idVal)}"]`);
          return (lbl?.textContent ?? "").trim();
        }, id);
      }
      if (!labelText) {
        labelText = await cb.evaluate((node) => {
          const parent = node.closest("label");
          if (parent) return (parent.textContent ?? "").trim();
          // 兄弟要素のテキスト (<input><span>同意する</span> パターン)
          const next = node.nextElementSibling;
          return (next?.textContent ?? "").trim();
        });
      }

      if (
        /同意|承諾|プライバシー|個人情報|利用規約|規約|consent|agree|privacy|terms/i.test(
          labelText,
        )
      ) {
        await checkOrClickLabel(cb, page);
      }
    } catch {
      /* ignore */
    }
  }
}

// フォーム内に checkbox が1つでもあって、まだ何もチェックされていなければ先頭をチェック。
// (processCheckboxes は agree 系か "name 同一が2個以上" でしかチェックしないため、
//  単独 checkbox が必須なケースを救う)
async function ensureAtLeastOneCheckboxChecked(
  page: Page,
  form: ElementHandle<Element>,
): Promise<void> {
  const checkboxes = await form.$$('input[type="checkbox"]');
  if (checkboxes.length === 0) return;
  const anyChecked = await form.$$eval(
    'input[type="checkbox"]',
    (els) => (els as HTMLInputElement[]).some((cb) => cb.checked),
  );
  if (!anyChecked) {
    await checkOrClickLabel(checkboxes[0]!, page);
  }
}

// ============= Radio handling =============

async function processRadios(
  page: Page,
  form: ElementHandle<Element>,
): Promise<void> {
  const radios = await form.$$('input[type="radio"]');
  if (radios.length === 0) return;

  // name 属性でグループ化し、各グループの先頭を選択。display:none の場合は label 経由。
  // name 属性が無いラジオは for 属性が "satori__custom_field" 等のラベルでまとめられて
  // いる可能性があるため、name が空のものは個別グループにする。
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
    await checkOrClickLabel(list[0]!, page);
  }
}

// ============= Submit button =============

// scope (form / div) と page の両方から submit ボタン候補を探す。
// scope 内に無い場合 (例: <form> 外に submit ボタンがあるレイアウト) は page 全体を再走査。
async function findSubmitButton(
  scope: ElementHandle<Element>,
  page: Page,
): Promise<ElementHandle<Element> | null> {
  const inScope = await findSubmitButtonIn(scope);
  if (inScope) return inScope;
  return await findSubmitButtonIn(page);
}

type Searchable = {
  $: (selector: string) => Promise<ElementHandle<Element> | null>;
  $$: (selector: string) => Promise<ElementHandle<Element>[]>;
};

// 通常クリック → force クリック → JS click() の順で試す (オーバーレイや
// カスタムCSSで pointer-events:none になっている要素を救う)
async function clickWithFallback(
  el: ElementHandle<Element>,
  page: Page,
): Promise<void> {
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 2_000 });
  } catch {
    /* ignore */
  }
  try {
    await el.click({ timeout: NAV_TIMEOUT });
    return;
  } catch {
    /* fallback */
  }
  try {
    await el.click({ force: true, timeout: NAV_TIMEOUT });
    return;
  } catch {
    /* fallback */
  }
  // 最後の手段: JS dispatch
  try {
    await el.evaluate((node) => (node as HTMLElement).click());
  } catch {
    /* ignore — caller がエラー判定を行う */
  }
  // navigate / network が動くチャンスを与える
  await page.waitForTimeout(200);
}

// 送信系ボタンとして許容するテキスト/value のパターン (お問い合わせ系含む)
const SUBMIT_TEXT_RE = /送\s*信|確\s*認|submit|send|確\s*定|問い?\s*合わ?\s*せる?|入力\s*内容\s*の?\s*確認|お?問い?合わ?せ\s*内容\s*の?\s*確認|next|次へ|登録|申し?込/i;

// 「戻る」「キャンセル」「リセット」など、押してはいけないボタンのテキスト/値
const NEGATIVE_BUTTON_RE = /戻る|キャンセル|リセット|クリア|削除|cancel|reset|clear|back|close|閉じる/i;

async function findSubmitButtonIn(scope: Searchable): Promise<ElementHandle<Element> | null> {
  // 1. type="submit" の input/button (value/text が「戻る」等でないことを確認)
  const typedAll = await scope.$$('input[type="submit"], button[type="submit"]');
  for (const el of typedAll) {
    const value = (await el.getAttribute("value")) ?? "";
    const text = ((await el.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(value) || NEGATIVE_BUTTON_RE.test(text)) continue;
    return el;
  }
  // type="submit" は見つかったが全部 negative の場合 — それでも最初を返す前に他を探す

  // 2. aria-label に submit / 送信 / send を含む要素 (ユーザ要件)
  const ariaCandidates = await scope.$$(
    '[aria-label*="submit" i], [aria-label*="送信"], [aria-label*="送 信"], [aria-label*="send" i], [aria-label*="確認" i], [aria-label*="問い合わ" i], [aria-label*="申込" i]',
  );
  for (const el of ariaCandidates) {
    const aria = (await el.getAttribute("aria-label")) ?? "";
    if (NEGATIVE_BUTTON_RE.test(aria)) continue;
    return el;
  }

  // 3. input[value="送信"] 等 (Japanese 主要パターン)
  const valuedInputs = await scope.$$(
    'input[value*="送信"], input[value*="送 信"], input[value*="確認"], input[value*="問い合わ"], input[value*="問合わ"], input[value*="申込"], input[value*="申し込"], input[value*="登録"], input[value*="次へ"], input[value*="同意して"], input[value*="Submit" i], input[value*="Send" i]',
  );
  for (const el of valuedInputs) {
    const value = (await el.getAttribute("value")) ?? "";
    if (NEGATIVE_BUTTON_RE.test(value)) continue;
    return el;
  }

  // 4. name に send/submit/confirm を含む button/input
  const sendLikeAll = await scope.$$(
    'button[name*="send"], button[name*="submit"], button[name*="confirm"], input[name*="send"], input[name*="submit"], input[name*="confirm"], button[name="entry"], input[name="entry"]',
  );
  for (const el of sendLikeAll) {
    const value = (await el.getAttribute("value")) ?? "";
    const text = ((await el.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(value) || NEGATIVE_BUTTON_RE.test(text)) continue;
    return el;
  }

  // 5. id/class に送信系のキーワードを含む要素 (negative class は除外)
  const idClassCandidates = await scope.$$(
    [
      '[id*="submit"]',
      '[id*="send"]',
      '[id*="contact"]',
      '[id*="confirm"]',
      'button[class*="submit"]',
      'button[class*="send"]',
      'button[class*="contact"]',
      'button[class*="btn-primary"]',
      'button[class*="btn_primary"]',
      'button[class*="btn--primary"]',
      'button[class*="btn-confirm"]',
      'button[class*="btn-send"]',
      'button[class*="confirm"]',
      'a[class*="submit"]',
      'a[class*="send"]',
      'a[class*="confirm"]',
      'a[class*="btn-primary"]',
      'div[class*="submit"]',
      'span[class*="submit"]',
    ].join(","),
  );
  for (const el of idClassCandidates) {
    const cls = (await el.getAttribute("class")) ?? "";
    const id = (await el.getAttribute("id")) ?? "";
    const text = ((await el.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(cls) || NEGATIVE_BUTTON_RE.test(id) || NEGATIVE_BUTTON_RE.test(text)) continue;
    return el;
  }

  // 6. role="button" でテキストに 送信/確認 を含むもの
  const roleButtons = await scope.$$('[role="button"]');
  for (const b of roleButtons) {
    const text = ((await b.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(text)) continue;
    if (SUBMIT_TEXT_RE.test(text)) return b;
  }

  // 7. <button> のテキストに 送信/確認/submit/send 等を含むもの
  const buttons = await scope.$$("button");
  for (const b of buttons) {
    const text = ((await b.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(text)) continue;
    if (SUBMIT_TEXT_RE.test(text)) return b;
  }

  // 8. <a> がボタンとして使われているケース
  const anchors = await scope.$$('a[class*="btn"], a[class*="button"], a[role="button"]');
  for (const a of anchors) {
    const text = ((await a.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(text)) continue;
    if (SUBMIT_TEXT_RE.test(text)) return a;
  }

  // 9. div/span にテキストでボタンを偽装しているケース (onclick / role なし)
  const divSpans = await scope.$$('div[class*="btn"], div[class*="button"], span[class*="btn"], span[class*="button"]');
  for (const el of divSpans) {
    const text = ((await el.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(text)) continue;
    if (SUBMIT_TEXT_RE.test(text)) return el;
  }

  // 10. 1. で除外していない type="submit" を最終的に拾う (negative 判定に false positive があった場合の保険)
  const typed = await scope.$('input[type="submit"], button[type="submit"]');
  if (typed) return typed;

  // 11. フォールバック: 最初の button (negative テキストでないもの)
  for (const b of await scope.$$("button")) {
    const text = ((await b.textContent()) ?? "").trim();
    if (NEGATIVE_BUTTON_RE.test(text)) continue;
    return b;
  }
  return null;
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

// 最終確認ボタン: id / name が submit 系で、かつ "戻る" でないもの。
// 部分一致 [id*="submit"] で satori__submit_post / submit_btn 等もカバー。
// value/text に「送信」/「Send」を含む方を優先するが、無くても submit_post 系は採用。
async function findFinalSubmitButton(
  page: Page,
): Promise<ElementHandle<Element> | null> {
  const candidates = await page.$$(
    '[id*="submit"], [name*="submit"], [id*="send"], [name*="send"]',
  );
  if (candidates.length === 0) return null;

  // 1st pass: 送信/Send を含むもの
  for (const el of candidates) {
    const value = (await el.getAttribute("value")) ?? "";
    const text = ((await el.textContent()) ?? "").trim();
    const id = (await el.getAttribute("id")) ?? "";
    if (NEGATIVE_BUTTON_RE.test(value) || NEGATIVE_BUTTON_RE.test(text)) continue;
    if (
      /Send\s*Message|送信|送 信|Send|Submit/i.test(value) ||
      /Send\s*Message|送信|送 信|Send|Submit/i.test(text) ||
      // Satori の satori__submit_post / submit_post パターン
      /submit_?post|submit_?send|submit_?final/i.test(id)
    ) {
      return el;
    }
  }
  return null;
}

// ============= Success / error detection =============
// 以前は /error/i など緩いパターンで footer/メタ等の関係ない "error" 文字列に
// 誤反応していた。下のパターンは「フォーム送信文脈っぽい日本語/英語」に絞る。

const SUCCESS_PATTERNS = [
  /送信(?:が)?完了/,
  /送信(?:が)?(?:され|済)/,
  /受け付け(?:ました|完了)/,
  /(?:お問い?合わ?せ|ご連絡).*(?:ありがと|受け付け|送信)/,
  /ありがとうございます/,
  /thank\s*you\s*(?:for|!|\.)/i,
  /(?:has|have)\s+been\s+(?:sent|received|submitted)/i,
  /successfully\s+(?:sent|submitted|received)/i,
  /your\s+message\s+has\s+been/i,
  /\bsubmission\s+complete/i,
];

const ERROR_PATTERNS = [
  /入力(?:に)?(?:エラー|不備|誤)/,
  /必須項目(?:が|は|を)/,
  /入力して(?:く|下さ)/,
  /(?:正しく|正確に).*(?:入力|ご記入)/,
  /メールアドレス.*正(?:しく|確)/,
  /電話番号.*正(?:しく|確)/,
  /※.*(?:必須|入力|ご記入)/,
  /\bvalidation\s*(?:failed|error)/i,
  /\binvalid\s+(?:input|email|format|value|character|address|phone|number)/i,
  /\brequired\s+(?:field|fields)/i,
  /please\s+(?:enter|fill|provide|select|check|complete|correct)/i,
  /could\s+not\s+(?:submit|send|process)/i,
  /failed\s+to\s+(?:submit|send)/i,
];

function isSuccessContent(content: string): boolean {
  return SUCCESS_PATTERNS.some((p) => p.test(content));
}
function isErrorContent(content: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(content));
}

// URL ベースの成功推定 (送信後に /thanks や /complete に飛ぶサイト用)
function looksLikeSuccessUrl(url: string): boolean {
  return /thank|thanks|complete|completed|success|received|finish|finished|done|sent|submitted|完了|お礼|kanryo|kanryou/i.test(url);
}

// 送信ボタン押下後の待機: ナビゲーション / インラインエラー出現 / 一定時間
// のいずれか早いものを採用。networkidle に依存しない (SPA fetch 形式に対応)。
// (記事の Fix #2)
async function waitForFormResponse(page: Page): Promise<void> {
  await Promise.race([
    page.waitForURL(() => true, { timeout: 5_000 }).catch(() => null),
    page
      .waitForSelector(
        '.error, .has-error, .is-error, .field-error, .form-error, .validation-error, .error-message, .error-msg, .errorText, .wpcf7-not-valid, .wpcf7-validation-errors, .mw_wp_form_error, [aria-invalid="true"], [role="alert"]',
        { timeout: 5_000 },
      )
      .catch(() => null),
    page.waitForTimeout(2_000),
  ]);
}

// 送信後にバリデーションで弾かれた疑いのフィールドを列挙してログ出力。
// (記事の Fix #7 — 何がダメだったかを可視化する)
async function logInvalidFields(page: Page): Promise<void> {
  try {
    const invalids = await page.$$eval(
      '[aria-invalid="true"], .wpcf7-not-valid, .mw_wp_form_error input, .mw_wp_form_error select, .mw_wp_form_error textarea, .has-error input, .has-error select, .has-error textarea, .is-error input, .is-error select, .is-error textarea',
      (els) =>
        els.map((e) => {
          const inp = e as HTMLInputElement;
          return {
            tag: inp.tagName.toLowerCase(),
            name: inp.name ?? "",
            id: inp.id ?? "",
            type: inp.type ?? "",
            value: inp.value ?? "",
          };
        }),
    );
    if (invalids.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("[form-submitter] INVALID FIELDS:", JSON.stringify(invalids));
    }
  } catch {
    /* ignore */
  }
}

// 実際に画面に表示されているエラー要素を検出 (.error / [aria-invalid] / role=alert 等)
async function hasVisibleErrorElement(page: Page): Promise<boolean> {
  try {
    return await page.$$eval(
      [
        ".error",
        ".has-error",
        ".is-error",
        ".field-error",
        ".form-error",
        ".validation-error",
        ".error-message",
        ".error-msg",
        ".errorText",
        '[aria-invalid="true"]',
        '[role="alert"]',
      ].join(","),
      (els) =>
        (els as HTMLElement[]).some((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const text = (el.textContent ?? "").trim();
          // 0文字や記号だけのコンテナはエラー文言ではないとみなす
          return text.length >= 2 && /\S/.test(text);
        }),
    );
  } catch {
    return false;
  }
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

    // 3) <select>, checkbox, radio を処理 (radios/checkboxes は label 経由 click 対応)
    await processSelects(form);
    await processCheckboxes(page, form);
    await processRadios(page, form);

    // 4) 最終セーフティネット: required 属性付きで未充填の要素をすべて埋める
    //    (input/textarea/checkbox/radio/select/date/number 等を網羅)
    await ensureAllRequiredFilled(page, form, input);
    // ラベル経由で「プライバシーポリシーに同意」系の checkbox をチェック
    await ensureAgreementsChecked(page, form);
    // checkbox が1つもチェックされていなければ先頭をチェック (必須同意ボックス対策)
    await ensureAtLeastOneCheckboxChecked(page, form);

    const submitBtn = await findSubmitButton(form, page);
    if (!submitBtn) {
      return {
        status: "failed",
        errorType: "SUBMIT_FAILED",
        errorMessage: "送信ボタンが見つかりませんでした。",
        httpStatus,
      };
    }

    const urlBefore = page.url();
    await clickWithFallback(submitBtn, page);
    await waitForFormResponse(page);

    // 確認画面が出るタイプのフォーム対策:
    // 次ページに「送信」value/text を持つ submit/name=send があれば、もう一度クリック
    const confirmBtn = await findConfirmationSendButton(page);
    if (confirmBtn) {
      await clickWithFallback(confirmBtn, page);
      await waitForFormResponse(page);
    }

    // 更に id/name="submit" を持ち value/text に "Send Message"/"送信" を含む要素があれば
    // 最終確認としてもう一度クリック (3段階目)
    const finalBtn = await findFinalSubmitButton(page);
    if (finalBtn) {
      await clickWithFallback(finalBtn, page);
      await waitForFormResponse(page);
    }

    // 遅延表示されるインラインエラー (JS で fetch 後に DOM 挿入されるパターン) を
    // 拾うため、さらに少し待ってから判定する
    await page.waitForTimeout(800);

    const urlAfter = page.url();
    const content = await page.content().catch(() => "");

    // デバッグ用: 画面上に残っている invalid フィールドを収集してログ出力
    // (記事の Fix #7 — どのフィールドで弾かれたか可視化する)
    await logInvalidFields(page);

    // 1) 明示的な成功文言
    if (isSuccessContent(content)) return { status: "success", httpStatus };

    // 2) 画面上のエラー要素 / エラー文言 → バリデーションエラー扱い
    if (isErrorContent(content) || (await hasVisibleErrorElement(page)))
      return {
        status: "failed",
        errorType: "VALIDATION_ERROR",
        errorMessage: "バリデーションエラーと思われる応答を検出しました。",
        httpStatus,
      };

    // 3) URL が thanks/complete 系に遷移していれば成功
    if (looksLikeSuccessUrl(urlAfter)) return { status: "success", httpStatus };

    // 4) URL は変わったがエラー文言が無い → 成功と推定 (確認画面を経た送信完了など)
    if (urlBefore !== urlAfter) return { status: "success", httpStatus };

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
