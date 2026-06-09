// AI フォーム解析が「姓/名分割・文字種・同意チェック・select 2番目」を正しく扱うか確認する。
// フォームへは一切送信しない (送信ボタンは押さず、生成プランを表示するのみ)。
// 実行: npx tsx src/_aiplan.test.ts
import { chromium } from "playwright";
import { generateFillPlan } from "./ai-form-analyzer.ts";
import { extractFormSnapshot } from "./form-submitter.ts";

const values = {
  company: "株式会社アド・フェニックス・エージェンシー",
  personName: "白石秀彦",
  personHiragana: "しらいしひでひこ",
  personKatakana: "シライシヒデヒコ",
  email: "shiraishi@adphoenix.co.jp",
  phone: "0368091657",
  postalCode: "1050021",
  address: "東京都港区東新橋２丁目１１ー７",
  url: "https://www.adphoenix.co.jp/",
  subject: "業務提携のご提案",
  message: "はじめてご連絡いたします。弊社サービスのご提案でご連絡しました。",
  position: "担当者",
};

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push("https://krs.bz/tglv/m/capty-inquiry1", "https://kozen.co.jp/contact/");
}

const browser = await chromium.launch({ headless: true });
for (const url of urls) {
  console.log(`\n========== ${url} ==========`);
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    const snap = await extractFormSnapshot(page);
    console.log(`fields=${snap.fields.length} buttons=${snap.buttons.length}`);
    const shot = await page.screenshot({ fullPage: true }).catch(() => undefined);
    const plan = await generateFillPlan({
      url: page.url(),
      fields: snap.fields,
      buttons: snap.buttons,
      values,
      screenshotPng: shot ?? undefined,
    });
    if (!plan) {
      console.log("⚠️ plan = null (APIキー未設定 or 解析失敗)");
    } else {
      console.log("FILLS:");
      for (const f of plan.fills) console.log(`  [${f.action}] ${f.selector} = ${JSON.stringify(f.value)}`);
      console.log("SUBMIT:", JSON.stringify(plan.submitSelectors));
      console.log("SUCCESS_TEXT:", JSON.stringify(plan.successText));
    }
  } catch (e) {
    console.log("ERROR:", (e as Error).message);
  } finally {
    await page.close().catch(() => null);
    await ctx.close().catch(() => null);
  }
}
await browser.close();
