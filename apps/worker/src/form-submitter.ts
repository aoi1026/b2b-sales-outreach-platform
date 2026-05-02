import { chromium, type Browser, type Page, type ElementHandle } from "playwright";
import type { FormInput, SubmitResult } from "./types.ts";

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

type FieldType = "company" | "person" | "email" | "phone" | "subject" | "message";

const NAV_TIMEOUT = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 MVPBusinessMessage/0.1";

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

async function detectFieldType(
  page: Page,
  el: ElementHandle<Element>,
): Promise<FieldType | null> {
  const name = (await el.getAttribute("name")) ?? "";
  const id = (await el.getAttribute("id")) ?? "";
  const placeholder = (await el.getAttribute("placeholder")) ?? "";
  const type = (await el.getAttribute("type")) ?? "";

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

  const combined = [name, id, placeholder, labelText, type]
    .join("|")
    .toLowerCase();

  if (type === "email" || /メール|mail|e-?mail/.test(combined)) return "email";
  if (type === "tel" || /電話|phone|tel/.test(combined)) return "phone";
  if (/会社|法人|団体|company|organization|organisation/.test(combined))
    return "company";
  if (/件名|タイトル|subject|title/.test(combined)) return "subject";
  if (/問い?合わ?せ|内容|message|comment|inquiry|body|質問|相談/.test(combined))
    return "message";
  if (/氏名|お名前|担当者|氏|name/.test(combined)) return "person";

  return null;
}

async function fillForm(
  page: Page,
  form: ElementHandle<Element>,
  input: FormInput,
): Promise<number> {
  const elements = await form.$$("input, textarea");
  let filled = 0;
  for (const el of elements) {
    const tagName = await el.evaluate((n) => n.tagName.toLowerCase());
    if (tagName === "input") {
      const t = (await el.getAttribute("type"))?.toLowerCase() ?? "text";
      if (
        ["submit", "button", "hidden", "checkbox", "radio", "file", "image", "reset"].includes(t)
      ) {
        continue;
      }
    }
    const fieldType = await detectFieldType(page, el);
    if (!fieldType) continue;
    const value = input[fieldType];
    if (value === undefined || value === null || value === "") continue;
    try {
      await el.fill(value);
      filled++;
    } catch {
      /* ignore individual field fill errors */
    }
  }
  return filled;
}

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
  if (SUCCESS_PATTERNS.some((p) => p.test(content))) return true;
  return false;
}

function isErrorContent(content: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(content));
}

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

    const filled = await fillForm(page, form, input);
    if (filled === 0) {
      return {
        status: "failed",
        errorType: "FIELD_MISMATCH",
        errorMessage: "フォーム項目にマッピングできませんでした。",
        httpStatus,
      };
    }

    const submitBtn =
      (await form.$('button[type="submit"], input[type="submit"]')) ??
      (await form.$("button")) ??
      null;
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
