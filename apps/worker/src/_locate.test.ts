// locateForm が FORM_NOT_FOUND だったサイトでフォームを検出できるか確認 (送信なし)。
// 実行: npx tsx src/_locate.test.ts
import { chromium } from "playwright";
import { getBrowser, locateForm } from "./form-submitter.ts";

const urls = [
  "https://add.gig.co.jp/contact/",
  "https://www.hakuten.co.jp/contact/business",
  "https://tosei.form.kintoneapp.com/public/d2d2b375896e9409e3df47bb43c429c68160bdee7782e838dc98302b0c6d8f5e",
  "https://tyo.co.jp/contact/",
  "https://www.teraokaseiko.com/jp/contact/",
  "https://www.mokmbs.com/contact/",
  "https://www.saaf-hd.co.jp/contact",
  "https://www.o-tec.co.jp/contact/",
];

const browser = await chromium.launch({ headless: true });
for (const url of urls) {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();
  let line = url.slice(0, 55);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const form = await locateForm(page);
    if (form) {
      const n = await form.$$eval("input:not([type=hidden]),select,textarea", (e) => e.length).catch(() => 0);
      line += `\n   ✅ FOUND form  inputs=${n}  finalUrl=${page.url().slice(0, 60)}`;
    } else {
      line += `\n   ❌ still not found  finalUrl=${page.url().slice(0, 60)}`;
    }
  } catch (e) { line += `\n   ERR ${(e as Error).message.split("\n")[0]}`; }
  console.log(line);
  await page.close().catch(()=>null); await ctx.close().catch(()=>null);
}
await browser.close();
void getBrowser;
