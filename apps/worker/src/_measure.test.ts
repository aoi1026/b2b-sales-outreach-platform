import { submitForm, submitFormWithAI, isAIFormAnalyzerEnabled, closeBrowser } from "./form-submitter.ts";
import { PrismaClient } from "../../../packages/db/generated/prisma/index.js";
import type { FormInput } from "./types.ts";
const p = new PrismaClient();
const jobIds = ["cmq7qh0rk0001js048k8mh8yv","cmq6q9du30001jv04dfxshv4c","cmq6cjouq0001l2043rboteyq"];
// 失敗社の URL を重複排除して収集
const seen = new Set<string>(); const urls: string[] = [];
for (const jobId of jobIds) {
  const job = await p.deliveryJob.findUnique({ where:{id:jobId}, include:{ list:{include:{companies:true}}, results:{omit:{screenshot:true}} } });
  for (const r of job!.results) {
    if (r.status==="SUCCESS") continue;
    const c = job!.list.companies.find(c=>c.id===r.companyId); if(!c) continue;
    if (seen.has(c.formUrl)) continue; seen.add(c.formUrl); urls.push(c.formUrl);
  }
}
await p.$disconnect();
console.log(`measuring ${urls.length} previously-failed sites (production code path, sticky proxy)`);
const input: FormInput = { company:"株式会社アド・フェニックス・エージェンシー", companyKana:null, person:"白石秀彦", personHiragana:"しらいしひでひこ", personKatakana:"シライシヒデヒコ", personKana:"シライシヒデヒコ", personLast:"白石", personFirst:"秀彦", email:"shiraishi@adphoenix.co.jp", phone:"0368091657", postalCode:"1050021", address:"東京都港区東新橋２丁目１１ー７ 住友東新橋ビル５号館３階", url:"https://www.adphoenix.co.jp/", subject:"業務提携のご提案", message:"はじめてご連絡いたします。弊社はWeb集客支援を行っており、貴社とご協業できればと考えご連絡しました。ご検討よろしくお願いいたします。", position:"担当者" };
const AI = new Set(["VALIDATION_ERROR","UNKNOWN","SUBMIT_FAILED","FORM_NOT_FOUND","FIELD_MISMATCH","CAPTCHA_FAILED"]);
let ok=0; const byType:Record<string,number>={};
for (let i=0;i<urls.length;i++){
  const url=urls[i]!;
  let res:any; let via="h";
  try { res = await submitForm(url, input, { timeoutMs:110_000 }); } catch(e){ res={status:"failed",errorType:"UNKNOWN",errorMessage:(e as Error).message}; }
  if (res.status!=="success" && isAIFormAnalyzerEnabled() && AI.has(res.errorType??"")) {
    try { const ai = await submitFormWithAI(url, input, { timeoutMs:110_000 }); if(ai.status==="success"||ai.screenshot){res=ai;via="AI";} } catch {}
  }
  if (res.status==="success") ok++; else byType[res.errorType??"?"]=(byType[res.errorType??"?"]||0)+1;
  console.log(`${i+1}/${urls.length} ${res.status==="success"?"✅":"❌"}[${via}] ${res.status}/${res.errorType??""} ${url.slice(0,52)}`);
}
console.log(`\n=== RESULT: ${ok}/${urls.length} success (${Math.round(ok/urls.length*100)}%) of previously-FAILED sites ===`);
console.log("remaining failures by type:", JSON.stringify(byType));
await closeBrowser();
