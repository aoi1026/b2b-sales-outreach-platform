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
export type SubmitOptions = {
  screenshotPath?: string;
  timeoutMs?: number;
  // Method A (CF7 + reCAPTCHA v3 限定フォールバック): 指定時はページ読込前に grecaptcha を
  // 乗っ取り、execute() がこのトークンを返すよう強制する (サイトに我々のトークンを使わせる)。
  forceV3Token?: string;
};

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
  | "person_kana_last"
  | "person_kana_first"
  | "person_hiragana_last"
  | "person_hiragana_first"
  | null;

// 住宅プロキシ経由だと重いフォームページ (iframe埋め込み/SPA) の読み込みに時間がかかり、
// 30秒では足りず TIMEOUT/FORM_NOT_FOUND になることがあるため余裕を持たせる。
const NAV_TIMEOUT = 45_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 MVPBusinessMessage/0.1";

// required を満たすためのフォールバック日本語
const REQUIRED_FALLBACK_TEXT = "問い合わせ";

// Method A (CF7 + reCAPTCHA v3): ページの全スクリプトより先に grecaptcha を乗っ取り、
// execute() が我々のトークンを返すよう強制する init script (文字列)。文字列にすることで
// esbuild の関数書き換え (__name) 由来のブラウザ ReferenceError を避ける。
function grecaptchaHijackScript(token: string): string {
  const t = JSON.stringify(token);
  return `(function(){
  var token = ${t};
  var g = {
    ready: function(cb){ try { if (cb) cb(); } catch(e){} },
    execute: function(){ return Promise.resolve(token); },
    render: function(){ return 0; },
    getResponse: function(){ return token; },
    reset: function(){}
  };
  g.enterprise = g;
  try {
    Object.defineProperty(window, 'grecaptcha', { configurable: true, get: function(){ return g; }, set: function(){} });
  } catch(e) { try { window.grecaptcha = g; } catch(e2){} }
  setInterval(function(){
    var els = document.querySelectorAll("input[name='_wpcf7_recaptcha_response'], input[name='g-recaptcha-response'], textarea[name='g-recaptcha-response']");
    for (var i=0;i<els.length;i++){ els[i].value = token; }
  }, 800);
})();`;
}

// プロキシ設定を組み立てる (方式2: 送信ごとに sticky session を切り替える)。
// PROXY_USERNAME / PROXY_PASSWORD のどちらかに "{session}" プレースホルダがあれば、
// 呼び出し(=1送信)ごとに新しいトークンへ置換する。同一トークン = 同一IP、別送信 = 別IP
// となり、「送信中はIP固定・社/試行ごとに別IP」を実現する。これによりナビゲーション
// 途中で出口IPが変わって net::ERR_NETWORK_CHANGED になる回転プロキシの不安定さを避ける。
//   iProyal はセッション指定をパスワード側に付ける形式:
//   PROXY_USERNAME="WTWZpmn7XLdU0OAz"
//   PROXY_PASSWORD="Uwc68mxeSFebYqEi_country-jp_session-{session}_lifetime-30m"
// プレースホルダが無ければ値をそのまま使う (既定の挙動)。
function buildProxyConfig(
  useProxy: boolean,
): { server: string; username?: string; password?: string } | undefined {
  if (!useProxy) return undefined;
  const server = process.env["PROXY_SERVER"];
  if (!server) return undefined;
  const token = Math.random().toString(36).slice(2, 12);
  const sub = (v: string | undefined): string | undefined =>
    v && v.includes("{session}") ? v.replace(/\{session\}/g, token) : v;
  const username = sub(process.env["PROXY_USERNAME"]);
  const password = sub(process.env["PROXY_PASSWORD"]);
  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

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

// プロキシのトンネル再接続等で一時的に出る net::ERR_NETWORK_CHANGED / ERR_PROXY 系は
// 同一 sticky IP のまま再試行すれば通ることが多い。これらの過渡的ナビゲーション失敗のみ
// 数回リトライする (恒久的な 4xx/5xx やDNS失敗は即 throw)。
const TRANSIENT_NAV_RE =
  /ERR_NETWORK_CHANGED|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_HTTP2_PROTOCOL_ERROR|socket hang up/i;

async function gotoWithRetry(
  page: Page,
  url: string,
  tries = 3,
): Promise<Awaited<ReturnType<Page["goto"]>>> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_NAV_RE.test((e as Error).message)) throw e;
      await page.waitForTimeout(700 + i * 600).catch(() => {});
    }
  }
  throw lastErr;
}

// SPA / 遅延描画フォーム対策: <form> タグ (または入力欄・埋め込み iframe) が現れるまで待つ。
// domcontentloaded 直後だと React/Vue 製フォームや kintone/formrun 等の埋め込みが未描画で
// FORM_NOT_FOUND になっていたため、最大 maxMs まで描画を待つ。さらに、描画を検知できた後も
// 「サイト描画から約3秒後に <form> が出てくる」ケースに合わせて約3秒の猶予を置き、全項目が
// 揃ってから検出に進む (埋め込み iframe が中身を読み込む時間にもなる)。
async function waitForFormRender(page: Page, maxMs = 8_000): Promise<void> {
  let detected = false;
  try {
    await page.waitForFunction(
      () => {
        // <form> タグが出ていれば最優先で採用
        if (document.querySelector("form")) return true;
        const top = document.querySelectorAll(
          "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea",
        ).length;
        if (top >= 2) return true;
        // 埋め込みフォーム (iframe) が存在すれば、そのロードを待つため true で抜ける
        return document.querySelectorAll('iframe[src^="http"]').length > 0;
      },
      { timeout: maxMs },
    );
    detected = true;
  } catch {
    /* タイムアウト — フォームが出ないサイトもある */
  }
  // 描画検知後は約3秒待って <form>/全項目が揃うのを待つ (未検知時は短めに)。
  await page.waitForTimeout(detected ? 3_000 : 800).catch(() => {});
}

// 埋め込みフォーム (form.run / kintoneapp / MovableType Form / Pardot 等) は本体が
// 子 iframe 内にあり、トップ document には <form> が無い。子 iframe のうち入力欄を多く
// 持つもの (= 実フォーム) の URL を返す。呼び出し側はそこへ直接 goto し直すことで、
// 以降のトップレベル処理 (入力・確認連鎖・成功判定・スクショ) をそのまま使える。
const EMBED_FORM_HOST_RE =
  /form\.run|kintoneapp\.com|formrun|movabletype\.net|hsforms\.|hubspot|pardot|formstack|formzu|tayori|docs\.google\.com\/forms|forms\.gle|shanon|cuenote|krs\.bz/i;

const FORM_INPUT_SEL =
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea";

async function countFormInputs(scope: {
  $$eval: ElementHandle<Element>["$$eval"];
}): Promise<number> {
  return await scope.$$eval(FORM_INPUT_SEL, (els) => els.length).catch(() => 0);
}

// 埋め込み iframe フォームを探す。iframe は非同期にロードされるため maxMs まで
// ポーリングし、入力欄を最も多く持つ子フレームの URL と入力数を返す。
async function findEmbeddedForm(
  page: Page,
  maxMs = 6_000,
): Promise<{ url: string; inputs: number } | null> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    let best: { url: string; inputs: number } | null = null;
    let bestN = 2; // トップに無い分、3 以上を実フォームとみなす
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      const u = fr.url();
      if (!u || !/^https?:/i.test(u)) continue;
      let n = 0;
      try {
        n = await fr.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          FORM_INPUT_SEL,
        );
      } catch {
        // cross-origin で中を読めない場合は既知フォームホストの src を採用
        n = EMBED_FORM_HOST_RE.test(u) ? 3 : 0;
      }
      if (n > bestN) {
        bestN = n;
        best = { url: u, inputs: n };
      }
    }
    if (best) return best;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

// ナビゲーション後にフォームを確実に得る: 描画待ち → トップで検出 → トップが弱い/無い場合は
// 埋め込み iframe の URL へ goto し直して再検出。戻り値は採用したフォーム (無ければ null)。
export async function locateForm(page: Page): Promise<ElementHandle<Element> | null> {
  await waitForFormRender(page);
  const topForm = await pickBestForm(page);
  const topInputs = topForm ? await countFormInputs(topForm) : 0;
  // 十分な入力欄を持つトップフォームがあればそれを採用
  if (topForm && topInputs >= 3) return topForm;

  // トップが弱い (1〜2入力) or 無い → 埋め込みフォームの方が豊かなら追従する
  const embed = await findEmbeddedForm(page);
  if (embed && embed.inputs > topInputs && embed.url !== page.url()) {
    await gotoWithRetry(page, embed.url).catch(() => {});
    await waitForFormRender(page);
    const f = await pickBestForm(page);
    if (f) return f;
  }
  return topForm;
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
      // 注: page.evaluate 内では名前付き内部関数を使わない (esbuild keepNames が __name を
      //     挿入し、ブラウザ側で "__name is not defined" になり meta 取得が全滅するため)。
      //     getAttribute はインラインで呼ぶ。
      let labelText = "";
      const idv = e.getAttribute("id") || "";
      if (idv) {
        const l = document.querySelector(`label[for="${CSS.escape(idv)}"]`);
        if (l?.textContent) labelText = l.textContent;
      }
      if (!labelText) {
        const w = e.closest("label");
        if (w?.textContent) labelText = w.textContent;
      }
      if (!labelText) {
        // name/id/label[for] を持たない行ベースのフォーム (kintone 等) 対策。
        // 「入力欄が1つだけの行コンテナ」を祖先に探し、その中のラベル要素を採用する。
        // 注: evaluate の引数名 (node) と衝突しないよう別名 (anc) を使う。
        let anc: Element | null = e.parentElement;
        for (let hop = 0; anc && hop < 6 && !labelText; hop++) {
          const inputCount = anc.querySelectorAll(
            "input:not([type=hidden]), select, textarea",
          ).length;
          if (inputCount <= 1) {
            const lab = anc.querySelector(
              'label, [class*="label"], [class*="title"], [class*="ttl"], [class*="head"], dt, th',
            );
            if (lab && !lab.querySelector("input, select, textarea")) {
              const t = (lab.textContent || "").replace(/[\s　]+/g, " ").trim();
              if (t && t.length <= 40) labelText = t;
            }
          }
          anc = anc.parentElement;
        }
      }
      return {
        name: e.getAttribute("name") || "",
        id: idv,
        placeholder: e.getAttribute("placeholder") || "",
        type: (e.getAttribute("type") || "").toLowerCase(),
        required: e.hasAttribute("required"),
        autocomplete: (e.getAttribute("autocomplete") || "").toLowerCase(),
        dataColumn: e.getAttribute("data-column") || "",
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

export function detectFieldRole(meta: ElementMeta): FieldRole {
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

  // ====== 氏名の分割欄 (姓/名 × 文字種) ======
  // 姓/名 に分かれた氏名欄を、文字種 (漢字/ひらがな/カタカナ) と合わせて判定する。
  // 例: lastName/firstName (漢字), lastNameKana+placeholder「せい/めい」(ひらがな),
  //     sei/mei+placeholder「セイ/メイ」(カタカナ)。
  // ここで先に確定させることで、"lastNameKana" が後段の lastname ルールに拾われて
  // 漢字氏名がひらがな欄へ流し込まれる誤りを防ぐ。
  {
    const ph = meta.placeholder; // 原文 (カタカナ/ひらがな判定のため小文字化しない)
    const partLast =
      /(?:^|[_\-])last[_\-]?name|lastname|(?:^|[_\-])sei(?:[_\-]|$)|name[_\-]?sei|family[_\-]?name|surname|姓|myoji|苗字|名字/.test(idOrName) ||
      /(?:^|[^ぁ-ゖ])せい(?:[^ぁ-ゖ]|$)|セイ|^\s*姓\s*$/.test(ph);
    const partFirst =
      /(?:^|[_\-])first[_\-]?name|firstname|(?:^|[_\-])mei(?:[_\-]|$)|name[_\-]?mei|given[_\-]?name/.test(idOrName) ||
      /(?:^|[^ぁ-ゖ])めい(?:[^ぁ-ゖ]|$)|メイ|^\s*名\s*$/.test(ph);
    if (partLast || partFirst) {
      const hira =
        /hira(?:gana)?|ひらがな/.test(idOrName) ||
        /ひらがな/.test(combined) ||
        /(?:^|[^ぁ-ゖ])(?:せい|めい)(?:[^ぁ-ゖ]|$)/.test(ph);
      const kata =
        !hira &&
        (/katakana|furigana|gana|(?:^|[_\-])kana(?:[_\-]|$)|kana|フリガナ|カナ|カタカナ/.test(idOrName) ||
          /フリガナ|カナ|カタカナ/.test(combined) ||
          /セイ|メイ/.test(ph));
      if (partLast)
        return hira ? "person_hiragana_last" : kata ? "person_kana_last" : "person_last";
      return hira ? "person_hiragana_first" : kata ? "person_kana_first" : "person_first";
    }
  }

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

// 半角 ASCII (英数記号) と半角スペースを全角に変換する。
// 「全角で入力してください」を要求するフォーム (krs.bz 等) で、半角スペースや
// 半角記号が混じった住所などが弾かれるのを防ぐ。
function toFullWidth(s: string): string {
  return s
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/ /g, "　");
}

// 氏名 (漢字/ひらがな/カタカナ) を 姓/名 に分割する。
// 空白 (半角/全角) があればそこで分割。無ければおおよそ半分で分割し、姓を前半とする。
// 空白なしの厳密分割は不可能なため、偶数長は半々、奇数長は姓 (前半) を1文字多くする。
// 例: "白石秀彦"→{山,名}=白石/秀彦, "しらいしひでひこ"→しらいし/ひでひこ。
export function splitNameParts(full: string | null | undefined): {
  last: string | null;
  first: string | null;
} {
  if (!full) return { last: null, first: null };
  const trimmed = full.trim();
  if (!trimmed) return { last: null, first: null };
  const bySpace = trimmed.split(/[\s　]+/).filter(Boolean);
  if (bySpace.length >= 2) {
    return { last: bySpace[0]!, first: bySpace.slice(1).join("") };
  }
  const chars = Array.from(trimmed); // サロゲートペア安全
  if (chars.length < 2) return { last: trimmed, first: null };
  const cut = Math.ceil(chars.length / 2);
  return { last: chars.slice(0, cut).join(""), first: chars.slice(cut).join("") };
}

export function pickValueForRole(role: FieldRole, input: FormInput): string | null {
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
      // 事前分割 (personLast) を優先。無ければ氏名を半分割した姓。
      return input.personLast ?? splitNameParts(input.person).last ?? input.person ?? null;
    case "person_first":
      // 事前分割 (personFirst) を優先。無ければ氏名を半分割した名。
      return input.personFirst ?? splitNameParts(input.person).first;
    case "person_kana_last":
      // カタカナ姓: 専用カタカナ → 汎用カナの順で分割。空白除去。
      return stripSpaces(splitNameParts(input.personKatakana ?? input.personKana).last);
    case "person_kana_first":
      return stripSpaces(splitNameParts(input.personKatakana ?? input.personKana).first);
    case "person_hiragana_last":
      // ひらがな姓: ひらがな氏名を分割。空白除去。
      return stripSpaces(splitNameParts(input.personHiragana).last);
    case "person_hiragana_first":
      return stripSpaces(splitNameParts(input.personHiragana).first);
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

  // 非表示要素フォールバック (Satori 等で隠し UI の裏に input が居るケース) や、
  // React/Vue 等の制御コンポーネント (kintone 等) 対策。後者は value プロパティを
  // 監視しているため、ネイティブの value setter 経由で設定して input を発火させる。
  try {
    await el.evaluate((node, val) => {
      const inp = node as HTMLInputElement | HTMLTextAreaElement;
      const proto =
        inp instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(inp, val);
      else inp.value = val;
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

// 同意/必須チェックボックスと判定するキーワード (name/id/label 共通)。
const CONSENT_RE =
  /同意|承諾|プライバシー|個人情報|利用規約|規約|consent|agree|accept|privacy|terms|doui/i;

// チェックボックスのラベル文字列 (label[for], 親<label>, 隣接要素) を取得。
async function readCheckboxLabel(
  cb: ElementHandle<Element>,
  page: Page,
  id: string,
): Promise<string> {
  let labelText = "";
  if (id) {
    labelText = await page
      .evaluate((idVal: string) => {
        const lbl = document.querySelector(`label[for="${CSS.escape(idVal)}"]`);
        return (lbl?.textContent ?? "").trim();
      }, id)
      .catch(() => "");
  }
  if (!labelText) {
    labelText = await cb
      .evaluate((node) => {
        const parent = node.closest("label");
        if (parent) return (parent.textContent ?? "").trim();
        const next = node.nextElementSibling;
        return (next?.textContent ?? "").trim();
      })
      .catch(() => "");
  }
  return labelText;
}

// select / radio / checkbox を一括処理し、各フィールドで「最低1つ選択済み」を保証する
// (ユーザ要件)。フォーム内の選択系入力をここに集約 (旧 processSelects/processCheckboxes/
// processRadios/ensureAgreementsChecked/ensureAtLeastOneCheckboxChecked を統合)。
//  - select  : 未選択なら2番目以降の有効 option (無ければ先頭の有効値) を選ぶ。
//  - radio   : name グループごとに、未選択なら先頭をチェック。
//  - checkbox: 同意/必須系を必ずチェック。どれも未チェックなら先頭をチェック。
async function applyChoiceDefaults(
  page: Page,
  form: ElementHandle<Element>,
): Promise<void> {
  // ---- <select> ----
  for (const sel of await form.$$("select")) {
    try {
      const cur = await sel.evaluate((n) => (n as HTMLSelectElement).value);
      if (cur && cur.trim() !== "") continue; // 既に選択済み
      const options = await sel.$$eval("option", (opts) =>
        (opts as HTMLOptionElement[]).map((o) => ({ value: o.value, disabled: o.disabled })),
      );
      const valid =
        options.find((o, i) => i > 0 && o.value.trim() !== "" && !o.disabled) ??
        options.find((o) => o.value.trim() !== "" && !o.disabled);
      if (valid) await sel.selectOption(valid.value).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  // ---- radio: name グループごとに未選択なら先頭をチェック ----
  const radios = await form.$$('input[type="radio"]');
  const groups = new Map<string, ElementHandle<Element>[]>();
  for (const r of radios) {
    const name = ((await r.getAttribute("name")) ?? "").toLowerCase();
    const key = name || `__nogroup_${groups.size}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const anyChecked = await Promise.all(
      list.map((r) => (r as ElementHandle<HTMLInputElement>).isChecked().catch(() => false)),
    ).then((arr) => arr.some(Boolean));
    if (!anyChecked && list[0]) await checkOrClickLabel(list[0], page);
  }

  // ---- checkbox: 同意/必須を必ずチェック + 最低1つ保証 ----
  const checkboxes = await form.$$('input[type="checkbox"]');
  if (checkboxes.length === 0) return;
  let anyChecked = false;
  for (const cb of checkboxes) {
    try {
      if (await (cb as ElementHandle<HTMLInputElement>).isChecked()) {
        anyChecked = true;
        continue;
      }
      const id = (await cb.getAttribute("id")) ?? "";
      const nameAttr = ((await cb.getAttribute("name")) ?? "").toLowerCase();
      const required = await cb.evaluate((n) => (n as HTMLInputElement).required).catch(() => false);
      const labelText = await readCheckboxLabel(cb, page, id);
      const isConsent =
        required ||
        CONSENT_RE.test(`${nameAttr}|${id.toLowerCase()}`) ||
        CONSENT_RE.test(labelText);
      if (isConsent) {
        await checkOrClickLabel(cb, page);
        anyChecked = true;
      }
    } catch {
      /* ignore */
    }
  }
  // どの checkbox もチェックされていなければ先頭をチェック (単独必須同意ボックス対策)
  if (!anyChecked && checkboxes[0]) await checkOrClickLabel(checkboxes[0], page);
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

    // 「全角」を要求する欄 (combined に全角ヒント) では半角を全角へ変換する。
    // メール/URL/電話/郵便番号は半角必須なので除外。
    if (
      /全角/.test(meta.combined) &&
      !["email", "email_confirm", "url", "phone", "fax", "postal_code"].includes(role ?? "")
    ) {
      value = toFullWidth(value);
    }

    const ok = await safeFill(el, value);
    if (ok) filled++;
  }

  return filled;
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

      // checkbox / radio は applyChoiceDefaults で選択保証済みのためここでは扱わない。
      if (tagName === "input" && (type === "checkbox" || type === "radio")) continue;

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

// 確認画面の最終送信ボタンを「見た目テキスト」で広く探す。type=submit でも id/name に
// submit/send を含まない、styled な <button>送信する</button> / <a>/<div> 等を救う。
// 「戻る/修正/キャンセル」等は除外する。可視な要素のみ返す。
async function findSendButtonByText(page: Page): Promise<ElementHandle<Element> | null> {
  const els = await page.$$(
    'button, input[type="submit"], input[type="button"], [role="button"], ' +
      'a[class*="btn"], a[class*="button"], div[class*="btn"], div[class*="button"], span[class*="btn"], span[class*="button"]',
  );
  for (const el of els) {
    const value = (await el.getAttribute("value")) ?? "";
    const text = ((await el.textContent()) ?? "").trim();
    const hay = `${value} ${text}`;
    if (NEGATIVE_BUTTON_RE.test(hay) || /修正|訂正/.test(hay)) continue;
    if (/送\s*信|この内容で|(?:上記|下記|以下)(?:の内容)?で(?:送信|よろし)|内容を送信|送信する|send|submit/i.test(hay)) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) return el;
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
      (await findConfirmationSendButton(page)) ??
      (await findFinalSubmitButton(page)) ??
      (await findSendButtonByText(page));
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
    // 既に成功画面に到達していれば確認段階は完了。ただし確認画面 (入力に戻る導線あり) では
    // 進捗ラベル「受付完了」等が成功文言に誤一致しても break せず、最終送信ボタンを押しに行く。
    const content = await page.content().catch(() => "");
    if (
      (isSuccessContent(content) || looksLikeSuccessUrl(page.url())) &&
      !(await onConfirmPage(page))
    )
      break;

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

// 注意: 確認画面 (「この内容で送信されます」「送信ボタンを押してください」等) を成功と
// 誤検知しないため、完了を表す語尾 (〜ました/〜完了) に限定する。未来形「送信されます」や
// 「送信する」は成功にしない。
const SUCCESS_PATTERNS = [
  // Contact Form 7 の確定的な成功マーカー (AJAX 後に付与される)
  /wpcf7-mail-sent-ok/,
  // 「送信完了」は2段階フォームの進捗ラベル (①入力②確認③送信完了) にも出るため、
  // 完了を表す語尾を伴うものだけ成功とみなす (バーのラベルでの誤検知を防ぐ)。
  /送信(?:が|を)?完了(?:しました|いたしました|致しました|です)/,
  /送信(?:が|を)?(?:され|いたし|済み)ました/, // 送信されました/送信いたしました
  /送信(?:を)?しました/, // 送信しました
  /(?:メッセージ|内容|フォーム)(?:を)?(?:送信|お送り)(?:しました|いたしました)/,
  /(?:お申し?込み?|申込|登録)(?:を)?(?:受け付けました|受付ました|完了(?:しました|いたしました))/,
  /(?:正常|無事)に(?:送信|完了|受付)/,
  /受け付け(?:ました|完了|いたしました)/,
  /受付(?:を)?(?:完了(?:しました)?|いたしました|ました)/,
  /(?:お問い?合わ?せ|ご連絡|ご質問).*(?:ありがとうございま|受け付けました|承りました)/,
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
  // Contact Form 7 の確定的な失敗マーカー (送信失敗/スパム判定/必須未同意/検証エラー)
  /wpcf7-mail-sent-ng|wpcf7-spam-blocked|wpcf7-acceptance-missing|wpcf7-validation-errors/,
  // 日本語の送信失敗文言 (jfrontier「メッセージの送信に失敗しました。後でもう一度お試しください。」等)
  /送信(?:に|が)?(?:失敗|できませんでした|できません)/,
  /(?:メッセージ|お問い?合わ?せ|内容).*(?:失敗(?:しました)?|できませんでした)/,
  /(?:もう一度|再度).{0,8}お試し/,
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

// 「確定的」な成功文言だけを集めた強シグナル。確認画面に送信ボタンが残っていても、
// これに当たれば送信完了とみなす。逆に SUCCESS_PATTERNS の「ありがとうございます」等は
// フォーム冒頭・フッタの定型挨拶にも出る弱シグナルなので、未送信(確認画面)では採用しない。
const STRONG_SUCCESS_PATTERNS = [
  /wpcf7-mail-sent-ok/,
  /送信(?:が|を)?完了(?:しました|いたしました|致しました|です)/,
  /送信(?:が|を)?(?:され|いたし|済み)ました/,
  /送信(?:を)?しました/,
  /(?:メッセージ|内容|フォーム)(?:を)?(?:送信|お送り)(?:しました|いたしました)/,
  /受け付け(?:ました|完了|いたしました)/,
  /受付(?:を)?(?:完了(?:しました)?|いたしました|ました)/,
  /(?:お申し?込み?|申込|登録)(?:を)?(?:受け付けました|受付ました|完了(?:しました|いたしました))/,
  /(?:正常|無事)に(?:送信|完了|受付)/,
  /送信が正常に/,
  /completed?\s+successfully/i,
  /(?:has|have)\s+been\s+(?:sent|received|submitted)/i,
  /successfully\s+(?:sent|submitted|received)/i,
  /your\s+(?:message|inquiry|request)\s+has\s+been/i,
];
function isStrongSuccess(content: string): boolean {
  return STRONG_SUCCESS_PATTERNS.some((p) => p.test(content));
}

// URL ベースの成功推定 (送信後に /thanks や /complete に飛ぶサイト用)
function looksLikeSuccessUrl(url: string): boolean {
  return /thank|thanks|complete|completed|success|received|finish|finished|done|sent|submitted|完了|お礼|kanryo|kanryou/i.test(url);
}

// 確認画面 (入力→確認→完了の「確認」段階) に居るか。確認画面に特有の
// 「入力画面に戻る / 内容を修正」ボタンが可視テキストにあるかで判定する。完了画面や
// 単発フォームの成功画面にはこの種の「入力に戻って修正する」導線が無いため、CF7 等の
// 成功 (送信ボタンが残るが back 導線は無い) と確実に区別できる。進捗バーの「受付完了/
// 送信完了」等のラベル誤検知に左右されないので、成功判定より優先して使う。
async function onConfirmPage(page: Page): Promise<boolean> {
  return await page
    .evaluate(() => {
      const txt = (document.body && document.body.innerText) || "";
      return /入力(?:画面|内容)?(?:へ|に)戻る|(?:内容|入力)を(?:修正|変更)|前の?(?:画面|ページ)に戻る/.test(
        txt,
      );
    })
    .catch(() => false);
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
          /(必須|入力して|ご記入|正しく|正確に|不正|誤り|エラー|無効|未入力|未選択|選択して|半角|全角|形式|文字以内|文字以上|同意(?:し|くださ|が必要)|失敗|できませんでした|お試し|required|invalid|enter\s|fill\s|select\s|must\s|missing|not\s+valid)/i;
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
  const proxy = buildProxyConfig(useProxy);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ...(proxy ? { proxy } : {}),
  });
  if (options?.forceV3Token) {
    await context.addInitScript(grecaptchaHijackScript(options.forceV3Token));
  }
  const page = await context.newPage();
  const overallMs = options?.timeoutMs ?? 170_000;
  const stageRef = { s: "ナビゲーション" };
  const core = async (): Promise<SubmitResult> => {
   try {
    const response = await gotoWithRetry(page, formUrl);
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
    // 描画待ち + 埋め込み iframe フォームへの追従を含めて検出する
    const form = await locateForm(page);
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

    // 3) select / radio / checkbox を一括処理し各フィールドで最低1つ選択を保証
    //    (旧 processSelects/Checkboxes/Radios + 同意チェックを applyChoiceDefaults に統合)
    await applyChoiceDefaults(page, form);

    // 4) 最終セーフティネット: required 属性付きで未充填の text/textarea/select/date/number を埋める
    await ensureAllRequiredFilled(page, form, input);

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

    // 送信後ページの判定 (撮影は上で完了済み)。確認画面で最終送信ボタンが残っている間は
    // 「未送信」とみなし、弱い成功シグナル (完了URL/advanced) は採用しない。確定的な成功
    // 文言 (isSuccessContent: wpcf7-mail-sent-ok / 送信完了しました / ありがとう 等) のみ別格。
    const onConfirm = await onConfirmPage(page);
    const advanced = urlBefore !== urlAfter || lastClickAt > 0;
    let result: SubmitResult;
    if (isErrorContent(content) || (await hasVisibleErrorElement(page))) {
      // 1) 画面上のエラー要素 / エラー文言 → バリデーションエラー扱い
      result = {
        status: "failed",
        errorType: "VALIDATION_ERROR",
        errorMessage: "バリデーションエラーと思われる応答を検出しました。",
        httpStatus,
      };
    } else if (onConfirm) {
      // 2) 確認画面 (入力に戻る導線あり) = 未送信。進捗ラベルの「受付完了」等が成功文言に
      //    誤一致しても成功にしない (誤計上防止)。
      result = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage: "確認画面で停止し、最終送信を完了できませんでした。スクリーンショットで要確認です。",
        httpStatus,
      };
    } else if (
      isStrongSuccess(content) ||
      isSuccessContent(content) ||
      looksLikeSuccessUrl(urlAfter) ||
      advanced
    ) {
      // 3) 確認画面でなく、成功文言/完了URL or 送信操作が進んだ → 成功 (方式B)。
      result = { status: "success", httpStatus };
    } else {
      result = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage: "送信後のページが成功と判定できませんでした。",
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

// Method A 用: ページを開いて「CF7 + reCAPTCHA v3」の社か確認し、該当時のみ CapSolver で
// 高スコアトークンを取得して返す。CF7-v3 以外は null (= Method A を発動させない)。
async function solveCF7v3Token(formUrl: string, useProxy: boolean): Promise<string | null> {
  const browser = await getBrowser();
  const proxy = buildProxyConfig(useProxy);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ...(proxy ? { proxy } : {}),
  });
  const page = await context.newPage();
  try {
    await gotoWithRetry(page, formUrl);
    await waitForFormRender(page);
    // CF7 のトークン欄が無ければ対象外 (他サイトに無影響)
    const isCf7 = await page.$("input[name='_wpcf7_recaptcha_response']");
    if (!isCf7) return null;
    const handle = await startCaptchaSolve(page);
    if (!handle || handle.info.type !== "recaptcha-v3") return null;
    const token = await Promise.race([
      handle.tokenPromise,
      new Promise<string>((r) => setTimeout(() => r(""), 60_000)),
    ]);
    return token || null;
  } catch {
    return null;
  } finally {
    await page.close().catch(() => null);
    await context.close().catch(() => null);
  }
}

// 公開API。直接接続を優先する: 住宅プロキシは重い iframe/SPA フォームページの読み込みが
// 遅く FORM_NOT_FOUND / TIMEOUT を多発させるため。直接で IPブロック (403/接続拒否
// = NETWORK_ERROR) されたときだけプロキシ経由で再試行する。CAPTCHA は CapSolver が自身の
// IP で解くため、直接接続でもスコアに不利は出ない。さらに CAPTCHA 拒否で失敗した CF7-v3 社
// には Method A (トークン強制注入) で再送する。
export async function submitForm(
  formUrl: string,
  input: FormInput,
  options?: SubmitOptions,
): Promise<SubmitResult> {
  const proxyConfigured = !!process.env["PROXY_SERVER"];
  const overallMs = options?.timeoutMs ?? 170_000;
  const deadline = Date.now() + overallMs;

  // 1) まず直接接続 (高速・重いページも描画できる)
  let result = await runSubmit(formUrl, input, { ...options, timeoutMs: overallMs }, false);

  // 2) 直接で IPブロックされた疑い (NETWORK_ERROR) のときだけプロキシで再試行
  if (
    result.status !== "success" &&
    proxyConfigured &&
    result.errorType === "NETWORK_ERROR" &&
    deadline - Date.now() >= 10_000
  ) {
    console.warn(`[form-submitter] direct blocked (${result.errorType}); retrying via proxy: ${formUrl}`);
    const viaProxy = await runSubmit(
      formUrl,
      input,
      { ...options, timeoutMs: deadline - Date.now() },
      true,
    );
    result =
      viaProxy.status === "success"
        ? viaProxy
        : viaProxy.screenshot && !result.screenshot
          ? viaProxy
          : result;
  }

  // 3) Method A (CF7 + reCAPTCHA v3 限定・失敗時のみ): CapSolver の高スコアトークンを
  //    grecaptcha 乗っ取りで強制注入して再送 (直接接続)。CF7-v3 以外は token=null で不発。
  const captchaProvider = !!(
    process.env["CAPSOLVER_API_KEY"] || process.env["TWOCAPTCHA_API_KEY"]
  );
  if (result.status !== "success" && result.errorType === "CAPTCHA_FAILED" && captchaProvider) {
    if (deadline - Date.now() >= 25_000) {
      try {
        const token = await solveCF7v3Token(formUrl, false);
        if (token) {
          console.info(`[form-submitter] Method A (CF7 v3 forced token) retry: ${formUrl}`);
          const forced = await runSubmit(
            formUrl,
            input,
            { ...options, timeoutMs: Math.max(8_000, deadline - Date.now()), forceV3Token: token },
            false,
          );
          if (forced.status === "success") return forced;
          if (forced.screenshot && !result.screenshot) result = forced;
        }
      } catch (e) {
        console.warn(`[form-submitter] Method A failed: ${(e as Error).message}`);
      }
    }
  }

  return result;
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
export async function extractFormSnapshot(
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

      // ラベル算出 (label[for] → 親 label → 祖先の data-column → 行コンテナ内のラベル要素)
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
      if (!label) {
        // name/id/label[for] を持たないフォーム (kintone 等) 対策。入力欄の祖先を数階層
        // たどり「この欄専用の行 (入力欄が1つだけのコンテナ)」を見つけ、その中の
        // ラベルらしい要素 (label / class に label・title・ttl・head を含む / dt / th) の
        // テキストをラベルとして採用する。
        let node: Element | null = el.parentElement;
        for (let hop = 0; node && hop < 6 && !label; hop++) {
          const inputCount = node.querySelectorAll(
            "input:not([type=hidden]), select, textarea",
          ).length;
          if (inputCount <= 1) {
            const lab = node.querySelector(
              'label, [class*="label" i], [class*="title" i], [class*="ttl" i], [class*="head" i], dt, th',
            );
            if (lab && !lab.querySelector("input, select, textarea")) {
              const t = (lab.textContent ?? "").replace(/[\s　]+/g, " ").trim();
              if (t && t.length <= 40) label = t;
            }
          }
          node = node.parentElement;
        }
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
  const proxy = buildProxyConfig(useProxy);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ...(proxy ? { proxy } : {}),
  });
  // Method A: forceV3Token 指定時は grecaptcha を乗っ取り我々のトークンを使わせる。
  if (options?.forceV3Token) {
    await context.addInitScript(grecaptchaHijackScript(options.forceV3Token));
  }
  const page = await context.newPage();
  const overallMs = options?.timeoutMs ?? 170_000;
  const stageRef = { s: "AI: ナビゲーション" };
  const core = async (): Promise<SubmitResult> => {
   try {
    const response = await gotoWithRetry(page, formUrl);
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

    // 描画待ち + 埋め込み iframe フォームへの追従 (戻り値の form は使わず副作用の
    // goto だけ利用)。これで snapshot が実フォームを拾えるようにする。
    await locateForm(page);

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

    // AI プランが取りこぼした選択系 (同意チェックボックス・select・radio) を保証する
    // セーフティネット。CF7 の acceptance-383 等を AI が check し損ねても確実に有効化する。
    const aiForm = await pickBestForm(page);
    if (aiForm) await applyChoiceDefaults(page, aiForm).catch(() => {});

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

    // 確認画面で最終送信ボタンが残っている間は未送信とみなす。確定的成功 (isStrongSuccess)
    // のみ別格で、弱いシグナル (AI の successText 一致 / 挨拶 / 完了URL / advanced) は
    // 「確認画面で停止していない」場合だけ採用する。
    const onConfirm = await onConfirmPage(page);
    const advanced = urlBefore !== urlAfter || lastClickAt > 0;
    const planSuccessHit = usedPlan.successText.length >= 2 && content.includes(usedPlan.successText);
    let result: SubmitResult;
    if (isErrorContent(content) || (await hasVisibleErrorElement(page))) {
      result = {
        status: "failed",
        errorType: "VALIDATION_ERROR",
        errorMessage: "バリデーションエラーと思われる応答を検出しました。",
        httpStatus,
      };
    } else if (onConfirm) {
      // 確認画面 (入力に戻る導線あり) = 未送信。進捗ラベル等の成功風テキストは無視する。
      result = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage: "確認画面で停止し、最終送信を完了できませんでした。スクリーンショットで要確認です。",
        httpStatus,
      };
    } else if (
      isStrongSuccess(content) ||
      planSuccessHit ||
      isSuccessContent(content) ||
      looksLikeSuccessUrl(urlAfter) ||
      advanced
    ) {
      result = { status: "success", httpStatus };
    } else {
      result = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage: "AI 送信後のページが成功と判定できませんでした。",
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
  const overallMs = options?.timeoutMs ?? 170_000;
  const deadline = Date.now() + overallMs;
  // submitForm と同方針: 直接接続を優先し、IPブロック (NETWORK_ERROR) のときだけプロキシ再試行。
  let result = await runSubmitAI(formUrl, input, options, false, cachedPlan);
  if (result.status === "success") return result;

  if (
    proxyConfigured &&
    result.errorType === "NETWORK_ERROR" &&
    deadline - Date.now() >= 10_000
  ) {
    const viaProxy = await runSubmitAI(
      formUrl,
      input,
      { ...options, timeoutMs: deadline - Date.now() },
      true,
      cachedPlan,
    );
    if (viaProxy.status === "success") return viaProxy;
    result = viaProxy.screenshot && !result.screenshot ? viaProxy : result;
  }

  // Method A (CF7 + reCAPTCHA v3 限定・失敗時のみ): captcha 拒否で失敗した CF7-v3 社に、
  // CapSolver の高スコアトークンを grecaptcha 乗っ取りで強制注入して再送する。AI プランは
  // first.recipe を再利用して Claude を呼び直さない。CF7-v3 以外は token=null で不発。
  const captchaProvider = !!(
    process.env["CAPSOLVER_API_KEY"] || process.env["TWOCAPTCHA_API_KEY"]
  );
  if (result.errorType === "CAPTCHA_FAILED" && captchaProvider && deadline - Date.now() >= 25_000) {
    try {
      const token = await solveCF7v3Token(formUrl, false);
      if (token) {
        console.info(`[form-submitter] Method A (AI, CF7 v3 forced token) retry: ${formUrl}`);
        const forced = await runSubmitAI(
          formUrl,
          input,
          { ...options, timeoutMs: Math.max(8_000, deadline - Date.now()), forceV3Token: token },
          false,
          result.recipe ?? cachedPlan,
        );
        if (forced.status === "success") return forced;
        if (forced.screenshot && !result.screenshot) result = forced;
      }
    } catch (e) {
      console.warn(`[form-submitter] Method A (AI) failed: ${(e as Error).message}`);
    }
  }

  return result;
}

// AI 解析機能が利用可能か (APIキーの有無)。
export function isAIFormAnalyzerEnabled(): boolean {
  return !!process.env["ANTHROPIC_API_KEY"];
}
