// 複数URLのフォーム存在状況を調べる (送信なし)。フォーム数/入力数/iframe内フォーム/captcha痕跡。
// 実行: npx tsx src/_probe.test.ts
import { chromium } from "playwright";

const urls = [
  "https://add.gig.co.jp/contact/",
  "https://www.hakuten.co.jp/contact/business",
  "https://tosei.form.kintoneapp.com/public/d2d2b375896e9409e3df47bb43c429c68160bdee7782e838dc98302b0c6d8f5e",
  "https://tyo.co.jp/contact/",
  "https://www.teraokaseiko.com/jp/contact/",
  "https://www.mokmbs.com/contact/",
  "https://www.saaf-hd.co.jp/contact",
  "https://www.o-tec.co.jp/contact/",
  "https://www.ctie.co.jp/contact/",
  "https://www.kpe.co.jp/contact/",
  "https://www.aist.go.jp/aist_j/inquiry/form/inquiry_form.html",
  "https://www.miyakokohsan.co.jp/contact",
  "https://www.scsk.jp/support/index.html",
  "https://jfrontier.jp/contact/",
  "https://kidshd.co.jp/contact/",
  "https://www.spool.co.jp/contact_ir/",
];

const browser = await chromium.launch({ headless: true });
for (const url of urls) {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();
  const r: any = { url };
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    r.http = resp?.status();
    await page.waitForTimeout(2500); // SPA描画待ち
    const top = await page.evaluate(() => ({
      forms: document.querySelectorAll("form").length,
      inputs: document.querySelectorAll("input:not([type=hidden]),select,textarea").length,
      iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.getAttribute("src") || "").slice(0, 5),
      recaptchaBadge: !!document.querySelector(".grecaptcha-badge,.g-recaptcha"),
      recaptchaText: /protected by reCAPTCHA|reCAPTCHA により保護/i.test(document.body?.innerText || ""),
    }));
    r.top = top;
    // iframe内も調べる
    r.frames = [];
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      try {
        const fi = await fr.evaluate(() => ({ forms: document.querySelectorAll("form").length, inputs: document.querySelectorAll("input:not([type=hidden]),select,textarea").length }));
        if (fi.inputs > 0 || fi.forms > 0) r.frames.push({ url: fr.url().slice(0, 60), ...fi });
      } catch { /* cross-origin */ r.frames.push({ url: fr.url().slice(0, 60), crossOrigin: true }); }
    }
  } catch (e) { r.error = (e as Error).message.split("\n")[0]; }
  console.log(JSON.stringify(r));
  await page.close().catch(()=>null); await ctx.close().catch(()=>null);
}
await browser.close();
