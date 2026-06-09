import { chromium, type Browser, type Page, type ElementHandle } from "playwright";
import type { FormInput, SubmitResult } from "./types.ts";
import { startCaptchaSolve, injectCaptchaToken, type CaptchaSolveHandle } from "./captcha-solver.ts";
import {
  generateFillPlan,
  type FieldDescriptor,
  type ButtonDescriptor,
  type FillPlan,
} from "./ai-form-analyzer.ts";

// 送信オプション。timeoutMs は1社あたりの残り処理時間 (これを超えたら現在画面を
// 撮影して TIMEOUT を返す)。
export type SubmitOptions = { screenshotPath?: string; timeoutMs?: number };

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  // 前回のブラウザがクラッシュ/切断していると newContext/newPage が無限待ちになりうる。
  // 切断を検知したら破棄して作り直す。
  if (browserInstance && !browserInstance.isConnected()) {
    try {
      await browserInstance.close();
    } catch {
      /* 既に死んでいる */
    }
    browserInstance = null;
  }
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
      // id/class が form-container / form-page 系の div フォーム (ユーザ報告のパターン)
      'div[class*="form-page"]',
      'div[class*="form_page"]',
      'div[class*="formPage"]',
      'div[class*="form-container"]',
      'div[class*="form_container"]',
      'div[class*="formContainer"]',
      'div[id*="form-container"]',
      'div[id*="form_container"]',
      'div[id*="form-page"]',
      'div[id*="form_page"]',
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

async function getElementMeta(_page: Page, el: ElementHandle<Element>) {
  // 属性とラベルを1回の evaluate でまとめて取得する。
  // (round-trip削減 + ページ遷移で context が破棄されても1要素の失敗で全体を落とさない)
  type RawMeta = {
    name: string;
    id: string;
    placeholder: string;
    type: string;
    required: boolean;
    autocomplete: string;
    dataColumn: string;
    tagName: string;
    labelText: string;
  };
  let raw: RawMeta;
  try {
    raw = await el.evaluate((node): RawMeta => {
      const e = node as HTMLElement;
      const get = (a: string) => e.getAttribute(a) ?? "";
      let labelText = "";
      const idv = get("id");
      if (idv) {
        const l = document.querySelector(`label[for="${CSS.escape(idv)}"]`);
        if (l?.textContent) labelText = l.textContent;
      }
      if (!labelText) {
        const w = e.closest("label");
        if (w?.textContent) labelText = w.textContent;
      }
      return {
        name: get("name"),
        id: idv,
        placeholder: get("placeholder"),
        type: get("type").toLowerCase(),
        required: e.hasAttribute("required"),
        autocomplete: get("autocomplete").toLowerCase(),
        dataColumn: get("data-column"),
        tagName: e.tagName.toLowerCase(),
        labelText,
      };
    });
  } catch {
    // context 破棄 (遷移) 等 — 空メタで継続
    raw = {
      name: "",
      id: "",
      placeholder: "",
      type: "",
      required: false,
      autocomplete: "",
      dataColumn: "",
      tagName: "",
      labelText: "",
    };
  }
  const { name, id, placeholder, type, required, tagName, labelText, autocomplete, dataColumn } =
    raw;

  return {
    name,
    id,
    placeholder,
    type,
    required,
    tagName,
    labelText,
    autocomplete,
    dataColumn,
    idLower: id.toLowerCase(),
    nameLower: name.toLowerCase(),
    combined: [name, id, placeholder, labelText, dataColumn, type].join("|").toLowerCase(),
  };
}

type ElementMeta = Awaited<ReturnType<typeof getElementMeta>>;

// ============= Field role detection =============

function detectFieldRole(meta: ElementMeta): FieldRole {
  const { tagName, type, idLower, nameLower, combined, autocomplete } = meta;
  const idOrName = `${idLower}|${nameLower}`;

  // <textarea> 要素は常に本文
  if (tagName === "textarea") return "message";

  // ====== autocomplete (Web標準トークン) による判定 — name/id より信頼度が高い ======
  // n-kokudo のように autocomplete="name/tel/email/postal-code/address-level1/2" で
  // 項目を表すフォームに対応。これらは標準値なので最優先で確定させる。
  switch (autocomplete) {
    case "name":
      return "person";
    case "family-name":
      return "person_last";
    case "given-name":
      return "person_first";
    case "organization":
      return "company";
    case "email":
      return "email";
    case "tel":
    case "tel-national":
      return "phone";
    case "postal-code":
      return "postal_code";
    case "address-level1": // 都道府県
    case "address-level2": // 市区町村
    case "street-address":
    case "address-line1":
    case "address-line2":
      return "address";
    case "url":
      return "url";
    default:
      break;
  }

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
  // Typeform 等の data-tf-type="confirm"/"submit" は明示的な意図なので最優先で採用。
  // (確認→送信の2段。confirm を先に拾い、無ければ submit。)
  const tfConfirm = await page.$('[data-tf-type="confirm"]');
  if (tfConfirm) return tfConfirm;
  const tfSubmit = await page.$('[data-tf-type="submit"]');
  if (tfSubmit) return tfSubmit;

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

// ページの状態シグネチャ (URL + 本文長)。確認画面の遷移検知・空ループ防止に使う。
async function pageSignature(page: Page): Promise<string> {
  const url = page.url();
  const len = (await page.content().catch(() => "")).length;
  return `${url}::${len}`;
}

// 確認/最終送信ボタンの出現を timeoutMs まで待つ。遅延表示や意図的な遅延に対応するため
// ポーリングする。可視な要素のみ返す。
async function waitForConfirmationButton(
  page: Page,
  timeoutMs: number,
): Promise<ElementHandle<Element> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const btn =
      (await findConfirmationSendButton(page)) ?? (await findFinalSubmitButton(page));
    if (btn) {
      const visible = await btn.isVisible().catch(() => false);
      if (visible) return btn;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

// 1段目の送信後、確認/検証ページに現れる「2つ目の送信ボタン」を出現待ち→クリックで
// 連鎖処理する。多段階の確認 (内容確認→送信完了) や、ボタンが遅延表示されるケースに対応。
// ご要望どおり、2つ目以降のボタンを押した「その時点」でスクリーンショットを撮る。
// 戻り値: 最後にクリックした時刻 (0 = 一度も確認ボタンを押していない)。
async function clickConfirmationChain(
  page: Page,
  options: { screenshotPath?: string } | undefined,
): Promise<{ lastClickAt: number }> {
  let lastClickAt = 0;
  let prevSig = await pageSignature(page);
  for (let round = 0; round < 4; round++) {
    // 既に成功と判定できる画面に到達していれば確認段階は完了
    const content = await page.content().catch(() => "");
    if (isSuccessContent(content) || looksLikeSuccessUrl(page.url())) break;

    const btn = await waitForConfirmationButton(page, 6_000);
    if (!btn) break;

    await clickWithFallback(btn, page);
    lastClickAt = Date.now();
    await waitForFormResponse(page);

    // 2つ目の送信ボタンを押した時点のスクリーンショットを撮影 (ファイル保存も含む)
    await takeShot(page, options);

    // 画面が変化していなければ同じボタンを押し続けている可能性が高いので打ち切る
    const sig = await pageSignature(page);
    if (sig === prevSig) break;
    prevSig = sig;
  }
  return { lastClickAt };
}

// ============= Success / error detection =============
// 以前は /error/i など緩いパターンで footer/メタ等の関係ない "error" 文字列に
// 誤反応していた。下のパターンは「フォーム送信文脈っぽい日本語/英語」に絞る。

const SUCCESS_PATTERNS = [
  /送信(?:が)?完了/,
  /送信(?:が)?(?:され|済)(?:ました)?/,
  /送信いたしました/,
  /受け付け(?:ました|完了|いたしました)/,
  /受付(?:を)?完了/,
  /(?:お問い?合わ?せ|ご連絡|ご質問).*(?:ありがと|受け付け|送信|承り)/,
  // 「お問い合わせありがとうございました」「ご連絡ありがとうございます」等
  /ありがとうござい(?:ます|ました)/,
  /(?:担当(?:者|部署)|後日|後ほど|改めて).*(?:ご連絡|ご返信|返信|連絡)/,
  /送信が正常に/,
  /completed?\s+successfully/i,
  /thank\s*you\s*(?:for|!|\.)/i,
  /(?:has|have)\s+been\s+(?:sent|received|submitted)/i,
  /successfully\s+(?:sent|submitted|received)/i,
  /your\s+(?:message|inquiry|request)\s+has\s+been/i,
  /\bsubmission\s+(?:complete|received)/i,
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
        ".wpcf7-not-valid-tip",
        ".mw_wp_form_error",
        '[aria-invalid="true"]',
        '[role="alert"]',
      ].join(","),
      (els) => {
        // 以前は「2文字以上のテキストがあれば即エラー」としていたため、送信成功なのに
        // 残存/汎用のエラー枠を拾って VALIDATION_ERROR を誤検知していた (最多の失敗原因)。
        // 「実際に可視」かつ「エラー文言にマッチ」する場合のみエラーとみなすよう厳格化する。
        const ERR =
          /(必須|入力して|ご記入|正しく|正確に|不正|誤り|エラー|無効|未入力|未選択|選択して|半角|全角|形式|文字以内|文字以上|同意(?:し|くださ|が必要)|required|invalid|enter\s|fill\s|select\s|must\s|missing|not\s+valid)/i;
        return (els as HTMLElement[]).some((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
            return false;
          // 親が非表示などで実際に描画されていない要素は除外
          if (el.offsetParent === null && style.position !== "fixed") return false;
          if (el.getAttribute("aria-hidden") === "true") return false;
          // aria-invalid="true" は「その項目が無効」という明確なマーク → 可視なら採用
          if (el.getAttribute("aria-invalid") === "true") return true;
          const text = (el.textContent ?? "").trim();
          if (text.length < 2) return false;
          // エラー文言にマッチした場合のみエラー扱い
          return ERR.test(text);
        });
      },
    );
  } catch {
    return false;
  }
}

// ============= Main =============

// 現在のページの最終画面を全画面 PNG で撮影して返す。
// screenshotPath 指定時はファイルにも保存する (dev 用)。撮影失敗は undefined。
async function takeShot(
  page: Page,
  options: { screenshotPath?: string } | undefined,
): Promise<Buffer | undefined> {
  try {
    const buf = await page.screenshot({
      fullPage: true,
      timeout: 15_000,
      ...(options?.screenshotPath ? { path: options.screenshotPath } : {}),
    });
    return buf ?? undefined;
  } catch {
    /* ページが閉じている / 撮影タイムアウト等は無視 */
    return undefined;
  }
}

// 成功・失敗を問わず、現在のページの最終画面を撮影し result に添付する。
async function attachShot(
  page: Page,
  options: { screenshotPath?: string } | undefined,
  result: SubmitResult,
): Promise<SubmitResult> {
  const buf = await takeShot(page, options);
  if (buf) result.screenshot = buf;
  return result;
}

// 送信中の例外を errorType に分類する。接続拒否・名前解決失敗・プロキシ系は
// NETWORK_ERROR にして、submitForm 側のプロキシ→直接接続フォールバックを誘発する。
function classifySubmitError(err: Error, stage: string): SubmitResult {
  const msg = err.message || String(err);
  if (err.name === "TimeoutError") {
    return { status: "failed", errorType: "TIMEOUT", errorMessage: `${msg}（段階: ${stage}）` };
  }
  if (
    /net::ERR_|ERR_EMPTY_RESPONSE|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_PROXY|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_SOCKET|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(
      msg,
    )
  ) {
    return { status: "failed", errorType: "NETWORK_ERROR", errorMessage: `${msg}（段階: ${stage}）` };
  }
  return { status: "failed", errorType: "UNKNOWN", errorMessage: `${msg}（段階: ${stage}）` };
}

// CAPTCHA が検出されたページで送信が失敗した場合、汎用の VALIDATION_ERROR/UNKNOWN を
// CAPTCHA_FAILED に再分類する。CAPTCHA の有無は失敗の主因を見分ける強いシグナルなので、
// メトリクス上で「CAPTCHA 壁による失敗」を切り分けられるようにする。
// 注: フィールド未充填など別要因の可能性も残るため、メッセージにトークン注入状況を残す。
function applyCaptchaClassification(
  result: SubmitResult,
  detected: boolean,
  tokenInjected: boolean,
): SubmitResult {
  if (result.status !== "failed" || !detected) return result;
  if (result.errorType !== "VALIDATION_ERROR" && result.errorType !== "UNKNOWN") return result;
  result.errorType = "CAPTCHA_FAILED";
  result.errorMessage = tokenInjected
    ? "CAPTCHA を検出しトークンを注入しましたが、送信が拒否されました（スコア不足/検証失敗の可能性）。"
    : "CAPTCHA を検出しましたが、解決トークンを取得できず送信できませんでした。";
  return result;
}

// core() の実行に「デッドライン監視」を付与する。overallMs を超えたら、その時点の
// 画面を撮影し、どの段階で詰まったか (stageRef.s) を添えた TIMEOUT を返す。
// これにより 1社あたりの時間切れでもスクリーンショットと原因を必ず記録できる。
async function withDeadline(
  page: Page,
  options: SubmitOptions | undefined,
  overallMs: number,
  stageRef: { s: string },
  core: () => Promise<SubmitResult>,
): Promise<SubmitResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineP = new Promise<SubmitResult>((resolve) => {
    timer = setTimeout(() => {
      void (async () => {
        const shot = await takeShot(page, options).catch(() => undefined);
        const result: SubmitResult = {
          status: "failed",
          errorType: "TIMEOUT",
          errorMessage: `処理時間 ${Math.round(overallMs / 1000)} 秒を超過しました（段階: ${stageRef.s}）。`,
        };
        if (shot) result.screenshot = shot;
        resolve(result);
      })();
    }, overallMs);
  });
  try {
    return await Promise.race([core(), deadlineP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 送信本体。useProxy=false の場合はプロキシを使わず直接接続する。
async function runSubmit(
  formUrl: string,
  input: FormInput,
  options: SubmitOptions | undefined,
  useProxy: boolean,
): Promise<SubmitResult> {
  const browser = await getBrowser();
  const proxyServer = useProxy ? process.env["PROXY_SERVER"] : undefined;
  const proxyUsername = process.env["PROXY_USERNAME"];
  const proxyPassword = process.env["PROXY_PASSWORD"];
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ...(proxyServer
      ? { proxy: { server: proxyServer, username: proxyUsername, password: proxyPassword } }
      : {}),
  });
  const page = await context.newPage();
  const overallMs = options?.timeoutMs ?? 170_000;
  const stageRef = { s: "ナビゲーション" };
  const core = async (): Promise<SubmitResult> => {
   try {
    const response = await page.goto(formUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    const httpStatus = response?.status() ?? 0;
    if (httpStatus >= 400) {
      return await attachShot(page, options, {
        status: "failed",
        errorType: "NETWORK_ERROR",
        errorMessage: `HTTP ${httpStatus}`,
        httpStatus,
      });
    }

    // リダイレクト (http→https / JS redirect) が落ち着くまで少し待つ。
    // 直後に DOM を読むと "Execution context was destroyed" で落ちることがあるため。
    await page.waitForTimeout(600).catch(() => {});

    stageRef.s = "フォーム検出";
    const form = await pickBestForm(page);
    if (!form) {
      return await attachShot(page, options, {
        status: "failed",
        errorType: "FORM_NOT_FOUND",
        errorMessage: "送信可能なフォームを検出できませんでした。",
        httpStatus,
      });
    }

    // キャプチャ検出 → バックグラウンドで解決開始 (フォーム充填と並行して待機)
    stageRef.s = "項目入力";
    let captchaHandle: CaptchaSolveHandle | null = null;
    try {
      captchaHandle = await startCaptchaSolve(page);
    } catch {
      /* キャプチャ検出に失敗しても処理を続行 */
    }

    // 1) tel × 3 / zip × 2 のような分割入力欄を先に埋める (ユーザ要件)
    const consumedNames = await fillSplitGroups(form, input);

    // 2) 通常のテキスト/textarea/email/tel フィールドを埋める
    const filled = await fillTextLikeFields(page, form, input, consumedNames);
    if (filled === 0 && consumedNames.size === 0) {
      return await attachShot(page, options, {
        status: "failed",
        errorType: "FIELD_MISMATCH",
        errorMessage: "フォーム項目にマッピングできませんでした。",
        httpStatus,
      });
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

    // キャプチャトークンをページに注入 (バックグラウンド解決の完了を待つ)
    let captchaTokenInjected = false;
    if (captchaHandle) {
      try {
        captchaTokenInjected = await injectCaptchaToken(page, captchaHandle);
      } catch {
        /* 注入失敗は無視して送信を試みる */
      }
    }

    const submitBtn = await findSubmitButton(form, page);
    if (!submitBtn) {
      return await attachShot(page, options, {
        status: "failed",
        errorType: "SUBMIT_FAILED",
        errorMessage: "送信ボタンが見つかりませんでした。",
        httpStatus,
      });
    }

    stageRef.s = "送信ボタン押下";
    const urlBefore = page.url();
    await clickWithFallback(submitBtn, page);
    const firstClickAt = Date.now();
    await waitForFormResponse(page);

    // 確認画面 (2段階送信) 対策:
    // 次ページに現れる「2つ目の送信ボタン」を出現待ち→クリックで連鎖処理する。
    // 多段階確認・遅延表示にも対応し、各クリック時点でスクリーンショットを撮る。
    stageRef.s = "確認画面・送信完了待ち";
    const { lastClickAt } = await clickConfirmationChain(page, options);

    // タイミングは「最後に押した送信ボタン」を基準にする
    // (確認ボタンを押していなければ1段目の送信ボタン押下時刻)。
    const submittedAt = lastClickAt || firstClickAt;

    // ユーザ要件: 最終送信ボタン押下から「1秒後」にスクリーンショットを撮り始める。
    const sinceLastClick = Date.now() - submittedAt;
    if (sinceLastClick < 1000) await page.waitForTimeout(1000 - sinceLastClick);
    const shot = await takeShot(page, options);

    const urlAfter = page.url();
    const content = await page.content().catch(() => "");

    // デバッグ用: 画面上に残っている invalid フィールドを収集してログ出力
    // (記事の Fix #7 — どのフィールドで弾かれたか可視化する)
    await logInvalidFields(page);

    // 送信後ページの判定 (撮影は上で完了済み)
    let result: SubmitResult;
    if (isSuccessContent(content)) {
      // 1) 明示的な成功文言
      result = { status: "success", httpStatus };
    } else if (isErrorContent(content) || (await hasVisibleErrorElement(page))) {
      // 2) 画面上のエラー要素 / エラー文言 → バリデーションエラー扱い
      result = {
        status: "failed",
        errorType: "VALIDATION_ERROR",
        errorMessage: "バリデーションエラーと思われる応答を検出しました。",
        httpStatus,
      };
    } else if (looksLikeSuccessUrl(urlAfter)) {
      // 3) URL が thanks/complete 系に遷移していれば成功
      result = { status: "success", httpStatus };
    } else {
      // 成功文言も完了URLも無い → 成功と断定しない。
      // 以前は「URLが変わっただけ」で成功計上していたが、確認画面到達を成功と
      // 誤判定し成功率が実態とズレていた。ここでは誤計上を避け「要目視確認」の
      // 失敗として記録する (スクリーンショットで実際の成否を確認できる)。
      const advanced = urlBefore !== urlAfter || lastClickAt > 0;
      result = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage: advanced
          ? "送信操作は完了しましたが、完了（成功）画面を確認できませんでした。スクリーンショットで要確認です。"
          : "送信後のページが成功と判定できませんでした。",
        httpStatus,
      };
    }
    // CAPTCHA 検出ページの失敗は CAPTCHA_FAILED に再分類する
    result = applyCaptchaClassification(result, captchaHandle !== null, captchaTokenInjected);
    if (shot) result.screenshot = shot;

    // ユーザ要件: 最終送信ボタン押下からこのサイトに「7秒間」は留まってから次へ進む
    // (スクリーンショットの取得が完了するまでの猶予を確保する)。
    const elapsed = Date.now() - submittedAt;
    if (elapsed < 7000) await page.waitForTimeout(7000 - elapsed);

    return result;
   } catch (e) {
    // 例外時 (タイムアウト/接続失敗/ナビゲーション失敗など) も、可能なら最終画面を残す。
    return await attachShot(page, options, classifySubmitError(e as Error, stageRef.s));
   }
  };
  try {
    return await withDeadline(page, options, overallMs, stageRef, core);
  } finally {
    await page.close().catch(() => null);
    await context.close().catch(() => null);
  }
}

// 公開API。プロキシ設定がある場合はまずプロキシ経由で試し、ネットワーク/タイムアウト
// 系の失敗 (プロキシの遅延・IPブロック等が疑われる) のときだけ直接接続で1回リトライする。
// 直接接続で成功すればそれを採用。両方失敗ならスクリーンショットが取れている方を返す。
export async function submitForm(
  formUrl: string,
  input: FormInput,
  options?: SubmitOptions,
): Promise<SubmitResult> {
  const proxyConfigured = !!process.env["PROXY_SERVER"];
  const overallMs = options?.timeoutMs ?? 170_000;
  const deadline = Date.now() + overallMs;

  const first = await runSubmit(formUrl, input, { ...options, timeoutMs: overallMs }, proxyConfigured);
  if (!proxyConfigured) return first;
  if (first.status === "success") return first;

  // プロキシ起因が疑われる失敗のみ直接接続でリトライ (残り時間内で)
  if (first.errorType === "NETWORK_ERROR" || first.errorType === "TIMEOUT") {
    const remaining = deadline - Date.now();
    if (remaining < 8_000) return first;
    console.warn(
      `[form-submitter] proxy attempt failed (${first.errorType}); retrying without proxy: ${formUrl}`,
    );
    const direct = await runSubmit(formUrl, input, { ...options, timeoutMs: remaining }, false);
    if (direct.status === "success") return direct;
    // どちらも失敗 — スクリーンショットがある方 (より後段まで進んだ方) を優先
    return direct.screenshot && !first.screenshot ? direct : first;
  }
  return first;
}

// ============= AI フォーム解析による送信 (フェーズB) =============

function inputToFillValues(input: FormInput) {
  return {
    company: input.company ?? null,
    personName: input.person ?? null,
    personHiragana: input.personHiragana ?? null,
    personKatakana: input.personKatakana ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    postalCode: input.postalCode ?? null,
    address: input.address ?? null,
    url: input.url ?? null,
    subject: input.subject ?? null,
    message: input.message ?? null,
    position: input.position ?? null,
  };
}

// ページ上のフォーム項目・ボタンを Claude に渡せる形へ抽出する。
async function extractFormSnapshot(
  page: Page,
): Promise<{ fields: FieldDescriptor[]; buttons: ButtonDescriptor[] }> {
  return await page.evaluate(() => {
    // 注: page.evaluate 内では名前付きの内部関数を使わない (esbuild の keepNames が
    // __name ヘルパを挿入し、ブラウザ側で ReferenceError になるため)。ラベル算出は
    // 各要素ごとにインラインで行う。
    const fields: FieldDescriptor[] = [];
    for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
      const tag = el.tagName.toLowerCase();
      const type = (
        el.getAttribute("type") ?? (tag === "select" ? "select-one" : "text")
      ).toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "image", "reset"].includes(type))
        continue;

      // ラベル算出 (label[for] → 親 label → 祖先の data-column)
      let label = "";
      const idAttr = el.getAttribute("id");
      if (idAttr) {
        const l = document.querySelector(`label[for="${CSS.escape(idAttr)}"]`);
        if (l?.textContent) label = l.textContent.trim();
      }
      if (!label) {
        const wrap = el.closest("label");
        if (wrap?.textContent) label = wrap.textContent.trim();
      }
      if (!label) {
        const col = el.closest("[data-column]");
        if (col?.getAttribute("data-column")) label = col.getAttribute("data-column") ?? "";
      }

      let options: { value: string; text: string }[] | undefined;
      if (tag === "select") {
        options = Array.from(el.querySelectorAll("option")).map((o) => ({
          value: (o as HTMLOptionElement).value,
          text: (o.textContent ?? "").trim(),
        }));
      } else if (type === "radio" || type === "checkbox") {
        // 各ラジオ/チェックは自身の value + ラベルを選択肢として持たせる
        options = [{ value: (el as HTMLInputElement).value, text: label }];
      }

      fields.push({
        tag,
        type,
        name: el.getAttribute("name") ?? "",
        id: el.getAttribute("id") ?? "",
        placeholder: el.getAttribute("placeholder") ?? "",
        label: label.slice(0, 120),
        autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(),
        dataColumn: el.closest("[data-column]")?.getAttribute("data-column") ?? "",
        required: el.hasAttribute("required"),
        ...(options ? { options } : {}),
      });
    }

    const buttons: ButtonDescriptor[] = [];
    const btnSel =
      'button, input[type="submit"], input[type="button"], [role="button"], a[class*="btn"], [data-tf-type]';
    for (const el of Array.from(document.querySelectorAll(btnSel))) {
      buttons.push({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") ?? "").toLowerCase(),
        name: el.getAttribute("name") ?? "",
        id: el.getAttribute("id") ?? "",
        text: (el.textContent ?? "").trim().slice(0, 80),
        value: el.getAttribute("value") ?? "",
      });
    }
    return { fields, buttons };
  });
}

// 生成された送信プランの fills を実行する。各項目の失敗は握り潰して次へ進む。
async function executeFillPlan(page: Page, plan: FillPlan): Promise<void> {
  for (const a of plan.fills) {
    try {
      const loc = page.locator(a.selector).first();
      if (a.action === "fill") {
        await loc.fill(a.value, { timeout: 5_000 });
      } else if (a.action === "select") {
        await loc
          .selectOption({ label: a.value }, { timeout: 5_000 })
          .catch(async () => {
            await loc.selectOption(a.value, { timeout: 5_000 });
          });
      } else if (a.action === "check") {
        await loc
          .check({ timeout: 5_000 })
          .catch(async () => {
            await loc.click({ timeout: 5_000 });
          });
      } else if (a.action === "click") {
        await loc.click({ timeout: 5_000 });
      }
    } catch {
      /* この項目は埋められなかった — 次へ */
    }
  }
}

// AI 解析で送信を試みる本体 (最後の手段)。cachedPlan があれば Claude を呼ばず再利用する。
async function runSubmitAI(
  formUrl: string,
  input: FormInput,
  options: SubmitOptions | undefined,
  useProxy: boolean,
  cachedPlan?: FillPlan,
): Promise<SubmitResult> {
  const browser = await getBrowser();
  const proxyServer = useProxy ? process.env["PROXY_SERVER"] : undefined;
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ...(proxyServer
      ? {
          proxy: {
            server: proxyServer,
            username: process.env["PROXY_USERNAME"],
            password: process.env["PROXY_PASSWORD"],
          },
        }
      : {}),
  });
  const page = await context.newPage();
  const overallMs = options?.timeoutMs ?? 170_000;
  const stageRef = { s: "AI: ナビゲーション" };
  const core = async (): Promise<SubmitResult> => {
   try {
    const response = await page.goto(formUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    const httpStatus = response?.status() ?? 0;
    if (httpStatus >= 400) {
      return await attachShot(page, options, {
        status: "failed",
        errorType: "NETWORK_ERROR",
        errorMessage: `HTTP ${httpStatus}`,
        httpStatus,
      });
    }

    // リダイレクトが落ち着くまで少し待つ (context destroyed 回避)
    await page.waitForTimeout(600).catch(() => {});

    // キャプチャはバックグラウンドで解決開始
    stageRef.s = "AI: フォーム解析";
    let captchaHandle: CaptchaSolveHandle | null = null;
    try {
      captchaHandle = await startCaptchaSolve(page);
    } catch {
      /* 続行 */
    }

    // 学習済みレシピがあればそれを使い (Claude 呼び出しをスキップ)、無ければ解析する。
    stageRef.s = "AI: 項目入力";
    let plan: FillPlan | null = cachedPlan ?? null;
    if (!plan) {
      const snapshot = await extractFormSnapshot(page);
      const preShot = await takeShot(page, undefined); // 視覚解析用 (ファイル保存しない)
      plan = await generateFillPlan({
        url: page.url(),
        fields: snapshot.fields,
        buttons: snapshot.buttons,
        values: inputToFillValues(input),
        screenshotPng: preShot,
      });
    }

    if (!plan || plan.fills.length === 0) {
      return await attachShot(page, options, {
        status: "failed",
        errorType: "FIELD_MISMATCH",
        errorMessage: "AI 解析で送信プランを生成できませんでした。",
        httpStatus,
      });
    }
    const usedPlan: FillPlan = plan;

    await executeFillPlan(page, usedPlan);

    stageRef.s = "AI: 送信";

    let captchaTokenInjected = false;
    if (captchaHandle) {
      try {
        captchaTokenInjected = await injectCaptchaToken(page, captchaHandle);
      } catch {
        /* 注入失敗は無視 */
      }
    }

    const urlBefore = page.url();

    // プランの submitSelectors を順にクリック。各押下後にスクリーンショット。
    let lastClickAt = 0;
    for (const sel of plan.submitSelectors) {
      try {
        await page.locator(sel).first().click({ timeout: 8_000 });
        lastClickAt = Date.now();
        await waitForFormResponse(page);
        await takeShot(page, options);
      } catch {
        /* このボタンは押せなかった */
      }
    }
    // プランのボタンが全滅なら汎用の送信ボタン検出にフォールバック
    if (lastClickAt === 0) {
      const form = await pickBestForm(page);
      const btn = form ? await findSubmitButton(form, page) : null;
      if (btn) {
        await clickWithFallback(btn, page);
        lastClickAt = Date.now();
        await waitForFormResponse(page);
      }
    }

    // 残りの確認画面 (2段階送信) は既存の連鎖処理に任せる
    const { lastClickAt: chainLast } = await clickConfirmationChain(page, options);
    const submittedAt = chainLast || lastClickAt || Date.now();

    const since = Date.now() - submittedAt;
    if (since < 1000) await page.waitForTimeout(1000 - since);
    const shot = await takeShot(page, options);

    const urlAfter = page.url();
    const content = await page.content().catch(() => "");
    await logInvalidFields(page);

    let result: SubmitResult;
    const planSuccessHit = usedPlan.successText.length >= 2 && content.includes(usedPlan.successText);
    if (planSuccessHit || isSuccessContent(content)) {
      result = { status: "success", httpStatus };
    } else if (isErrorContent(content) || (await hasVisibleErrorElement(page))) {
      result = {
        status: "failed",
        errorType: "VALIDATION_ERROR",
        errorMessage: "バリデーションエラーと思われる応答を検出しました。",
        httpStatus,
      };
    } else if (looksLikeSuccessUrl(urlAfter)) {
      result = { status: "success", httpStatus };
    } else {
      result = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage:
          urlBefore !== urlAfter || lastClickAt > 0
            ? "AI 送信は実行しましたが、完了（成功）画面を確認できませんでした。スクリーンショットで要確認です。"
            : "AI 送信後のページが成功と判定できませんでした。",
        httpStatus,
      };
    }
    // CAPTCHA 検出ページの失敗は CAPTCHA_FAILED に再分類する
    result = applyCaptchaClassification(result, captchaHandle !== null, captchaTokenInjected);
    if (shot) result.screenshot = shot;
    // 学習用: 実行したプランを結果に添付 (成功時に job-processor がレシピ保存する)
    result.recipe = usedPlan;

    const elapsed = Date.now() - submittedAt;
    if (elapsed < 7000) await page.waitForTimeout(7000 - elapsed);
    return result;
   } catch (e) {
    console.warn("[runSubmitAI] error:", (e as Error).message ?? String(e));
    return await attachShot(page, options, classifySubmitError(e as Error, stageRef.s));
   }
  };
  try {
    return await withDeadline(page, options, overallMs, stageRef, core);
  } finally {
    await page.close().catch(() => null);
    await context.close().catch(() => null);
  }
}

// 公開API: ヒューリスティック送信が失敗した社に対し、Claude による解析で再送する。
// ANTHROPIC_API_KEY 未設定なら呼んでも null 相当 (FIELD_MISMATCH) になる。
export async function submitFormWithAI(
  formUrl: string,
  input: FormInput,
  options?: SubmitOptions,
  cachedPlan?: FillPlan,
): Promise<SubmitResult> {
  const proxyConfigured = !!process.env["PROXY_SERVER"];
  return await runSubmitAI(formUrl, input, options, proxyConfigured, cachedPlan);
}

// AI 解析機能が利用可能か (APIキーの有無)。
export function isAIFormAnalyzerEnabled(): boolean {
  return !!process.env["ANTHROPIC_API_KEY"];
}
