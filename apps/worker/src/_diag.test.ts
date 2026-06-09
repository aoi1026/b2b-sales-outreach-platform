// フォームを埋めて「送信せず」に検証状態を観察する診断ツール。
// 各フィールドの validity / validationMessage / required / 値、confirm要素、recaptcha痕跡を出す。
// 実行: npx tsx src/_diag.test.ts <url>
import { chromium } from "playwright";
import { extractFormSnapshot } from "./form-submitter.ts";
import { generateFillPlan } from "./ai-form-analyzer.ts";

const values = {
  company: "株式会社アド・フェニックス・エージェンシー",
  personName: "白石秀彦", personHiragana: "しらいしひでひこ", personKatakana: "シライシヒデヒコ",
  email: "shiraishi@adphoenix.co.jp", phone: "0368091657", postalCode: "1050021",
  address: "東京都港区東新橋２丁目１１ー７", url: "https://www.adphoenix.co.jp/",
  subject: "業務提携のご提案", message: "はじめてご連絡いたします。ご提案でご連絡しました。", position: "担当者",
};
const url = process.argv[2] ?? "https://krs.bz/tglv/m/capty-inquiry1";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1000);
const snap = await extractFormSnapshot(page);
const shot = await page.screenshot({ fullPage: true }).catch(() => undefined);
const plan = await generateFillPlan({ url: page.url(), fields: snap.fields, buttons: snap.buttons, values, screenshotPng: shot ?? undefined });
console.log("PLAN fills:", plan?.fills.length, "submit:", JSON.stringify(plan?.submitSelectors));

// プランを適用 (送信ボタンは押さない)
for (const a of plan?.fills ?? []) {
  try {
    const loc = page.locator(a.selector).first();
    if (a.action === "fill") await loc.fill(a.value, { timeout: 4000 });
    else if (a.action === "select") await loc.selectOption({ label: a.value }, { timeout: 4000 }).catch(() => loc.selectOption(a.value, { timeout: 4000 }));
    else if (a.action === "check") await loc.check({ timeout: 4000 }).catch(() => loc.click({ timeout: 4000 }));
    else if (a.action === "click") await loc.click({ timeout: 4000 });
  } catch (e) { console.log("  fill fail:", a.selector, (e as Error).message.split("\n")[0]); }
}

// 検証状態を観察 (送信なし)
const report = await page.evaluate(() => {
  const out: any = { fields: [], formValid: null, recaptcha: {} };
  const forms = Array.from(document.querySelectorAll("form"));
  out.formCount = forms.length;
  for (const el of Array.from(document.querySelectorAll("input,select,textarea")) as any[]) {
    if (["hidden","submit","button","image","reset"].includes(el.type)) continue;
    const valid = typeof el.checkValidity === "function" ? el.checkValidity() : true;
    if (!valid || el.required) out.fields.push({ name: el.name, type: el.type, required: el.required, valid, msg: el.validationMessage, value: (el.value||"").slice(0,30) });
  }
  out.recaptcha.badge = !!document.querySelector(".grecaptcha-badge");
  out.recaptcha.gRecaptcha = !!document.querySelector(".g-recaptcha");
  out.recaptcha.hasGrecaptchaObj = typeof (window as any).grecaptcha !== "undefined";
  out.recaptcha.cfg = (() => { try { const c=(window as any).___grecaptcha_cfg; if(!c)return null; return Object.keys(c.clients||{}); } catch { return "err"; } })();
  out.confirmButtons = Array.from(document.querySelectorAll('input[type=submit],button')).map((b:any)=>({t:(b.value||b.textContent||"").trim().slice(0,20)}));
  return out;
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
