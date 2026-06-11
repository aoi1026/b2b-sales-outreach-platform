import { mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "../../../packages/db/generated/prisma/index.js";
import {
  submitForm,
  submitFormWithAI,
  isAIFormAnalyzerEnabled,
  closeBrowser,
  splitNameParts,
} from "./form-submitter.ts";
import type { FillPlan } from "./ai-form-analyzer.ts";
import type { DeliveryJobPayload, FormInput } from "./types.ts";

const prisma = new PrismaClient();

const INTER_COMPANY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 3;
// 1社あたりの全リトライ含む最大処理時間。これを超えると TIMEOUT 扱いで次社へ。
const PER_COMPANY_TIMEOUT_MS = 180_000;
// レシピがこの回数連続的に失敗したら無効化し、次回は Claude で作り直す。
const RECIPE_FAIL_DISABLE_THRESHOLD = 3;

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

// ============= フェーズC: 学習レシピ (FormRecipe) =============

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// 有効かつ失敗閾値未満の学習済みレシピを返す。無ければ null。
async function loadRecipe(domain: string): Promise<FillPlan | null> {
  try {
    const r = await prisma.formRecipe.findUnique({ where: { domain } });
    if (!r || !r.enabled) return null;
    if (r.failCount >= RECIPE_FAIL_DISABLE_THRESHOLD) return null;
    const plan = r.plan as unknown as FillPlan;
    if (!plan || !Array.isArray(plan.fills)) return null;
    await prisma.formRecipe
      .update({ where: { domain }, data: { lastUsedAt: new Date() } })
      .catch(() => null);
    return plan;
  } catch (e) {
    console.warn(`[worker] loadRecipe(${domain}) failed:`, (e as Error).message);
    return null;
  }
}

// AI送信の成否でレシピを強化/淘汰する。成功時は plan を保存し失敗カウントをリセット、
// 失敗時は失敗カウントを増やし、閾値到達で無効化 (次回 Claude が作り直す)。
async function recordRecipeOutcome(
  domain: string,
  success: boolean,
  plan?: FillPlan,
): Promise<void> {
  try {
    if (success && plan) {
      await prisma.formRecipe.upsert({
        where: { domain },
        create: { domain, plan: plan as unknown as object, successCount: 1, enabled: true, lastUsedAt: new Date() },
        update: { plan: plan as unknown as object, successCount: { increment: 1 }, failCount: 0, enabled: true, lastUsedAt: new Date() },
      });
      return;
    }
    if (!success) {
      const r = await prisma.formRecipe.findUnique({ where: { domain } });
      if (!r) return;
      const nextFail = r.failCount + 1;
      await prisma.formRecipe.update({
        where: { domain },
        data: { failCount: nextFail, enabled: nextFail < RECIPE_FAIL_DISABLE_THRESHOLD },
      });
    }
  } catch (e) {
    console.warn(`[worker] recordRecipeOutcome(${domain}) failed:`, (e as Error).message);
  }
}

// 半角 ASCII/スペースを全角へ変換 (バリデーション失敗時の適応リトライ用)。
function fw(s: string | null | undefined): string | null | undefined {
  if (s == null) return s;
  return s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, "　");
}
// 氏名・会社名・住所などを全角化した入力を返す (メール/電話/郵便番号/URL/本文は除外)。
// 「全角で入力してください」を要求するフォームで半角混入により弾かれたときの再試行に使う。
function toFullWidthInput(inp: FormInput): FormInput {
  return {
    ...inp,
    company: fw(inp.company) ?? null,
    companyKana: fw(inp.companyKana) ?? null,
    person: fw(inp.person) ?? null,
    personHiragana: fw(inp.personHiragana) ?? null,
    personKatakana: fw(inp.personKatakana) ?? null,
    personKana: fw(inp.personKana) ?? null,
    personLast: fw(inp.personLast) ?? null,
    personFirst: fw(inp.personFirst) ?? null,
    address: fw(inp.address) ?? null,
    position: fw(inp.position) ?? null,
  };
}

function applyVars(text: string, companyName: string): string {
  return text
    .replace(/\{\{\s*会社名\s*\}\}/g, companyName)
    .replace(/\{\{\s*担当者名\s*\}\}/g, "ご担当者");
}

async function ensureJobResultRows(jobId: string): Promise<void> {
  const job = await prisma.deliveryJob.findUnique({
    where: { id: jobId },
    include: { list: { include: { companies: true } } },
  });
  if (!job) return;

  const existingCount = await prisma.deliveryResult.count({ where: { jobId } });
  if (existingCount >= job.list.companies.length) return;

  for (const c of job.list.companies) {
    await prisma.deliveryResult.upsert({
      where: { jobId_companyId: { jobId, companyId: c.id } },
      update: {},
      create: { jobId, companyId: c.id, status: "PENDING" },
    });
  }
  await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { plannedCount: job.list.companies.length },
  });
}

async function refreshJobFlags(jobId: string) {
  return prisma.deliveryJob.findUnique({
    where: { id: jobId },
    select: { pauseRequested: true, cancelRequested: true, status: true },
  });
}

export async function processDeliveryJob(
  payload: DeliveryJobPayload,
): Promise<void> {
  const { jobId } = payload;
  if (!jobId) return;

  await ensureJobResultRows(jobId);

  const job = await prisma.deliveryJob.findUnique({
    where: { id: jobId },
    include: {
      list: { include: { companies: true } },
      messageTemplate: true,
      fallbackMessageTemplate: true,
      senderTemplate: true,
      // screenshot (PNG bytes) は不要かつ重いので除外
      results: { omit: { screenshot: true } },
    },
  });
  if (!job) {
    console.log(`[worker] job ${jobId} not found`);
    return;
  }
  if (job.status === "CANCELLED" || job.status === "DONE") return;

  console.log(`[worker] start job ${jobId} (${job.list.companies.length} companies)`);

  await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: job.startedAt ?? new Date() },
  });

  const screenshotEnabled = process.env["WORKER_SCREENSHOT"] === "true";
  const screenshotDir = screenshotEnabled
    ? join(process.env["WORKER_SCREENSHOT_DIR"] ?? "./screenshots", jobId)
    : null;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    console.log(`[worker] screenshots → ${screenshotDir}`);
  }

  const blEntries = await prisma.blacklistEntry.findMany();
  const blDomains = new Set(
    blEntries
      .filter((e) => e.type === "DOMAIN")
      .map((e) => e.value.toLowerCase()),
  );
  const blNames = new Set(
    blEntries.filter((e) => e.type === "COMPANY_NAME").map((e) => e.value),
  );

  let successCount = job.successCount;
  let failedCount = job.failedCount;
  let skippedCount = job.skippedCount;

  const pendingCompanies = job.list.companies.filter((c) => {
    const existing = job.results.find((r) => r.companyId === c.id);
    return !existing || existing.status === "PENDING" || existing.status === "RUNNING";
  });

  for (const company of pendingCompanies) {
    const flags = await refreshJobFlags(jobId);
    if (!flags) break;
    if (flags.cancelRequested) {
      await prisma.deliveryJob.update({
        where: { id: jobId },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
      console.log(`[worker] job ${jobId} cancelled`);
      return;
    }
    if (flags.pauseRequested) {
      await prisma.deliveryJob.update({
        where: { id: jobId },
        data: { status: "PAUSED" },
      });
      console.log(`[worker] job ${jobId} paused`);
      return;
    }

    // BL check
    let domain: string | null = null;
    try {
      domain = new URL(company.formUrl).hostname.toLowerCase();
    } catch {
      domain = null;
    }
    if ((domain && blDomains.has(domain)) || blNames.has(company.name)) {
      skippedCount++;
      await prisma.deliveryResult.update({
        where: { jobId_companyId: { jobId, companyId: company.id } },
        data: {
          status: "SKIPPED",
          errorType: "BLACKLISTED",
          errorMessage: "ブラックリストに該当するため送信をスキップしました。",
          attemptedAt: new Date(),
        },
      });
      continue;
    }

    const personName = job.senderTemplate?.personName ?? null;
    const { last: personLast, first: personFirst } = splitNameParts(personName);

    const input: FormInput = {
      company: job.senderTemplate?.companyName ?? null,
      // 会社のカナは現状 SenderTemplate に欄がないため null。form-submitter 側では
      // 不在時は漢字社名にフォールバックする。
      companyKana: null,
      person: personName,
      personHiragana: job.senderTemplate?.personHiragana ?? null,
      personKatakana: job.senderTemplate?.personKatakana ?? null,
      // personKana は後方互換用。明示的にカタカナがあればそれ、無ければ漢字。
      personKana: job.senderTemplate?.personKatakana ?? null,
      personLast,
      personFirst,
      email: job.senderTemplate?.email ?? null,
      phone: job.senderTemplate?.phone ?? null,
      postalCode: job.senderTemplate?.postalCode ?? null,
      address: job.senderTemplate?.address ?? null,
      url: job.senderTemplate?.url ?? null,
      subject: applyVars(job.messageTemplate.subject, company.name),
      message: applyVars(job.messageTemplate.body, company.name),
      position: "担当者",
    };

    await prisma.deliveryResult.update({
      where: { jobId_companyId: { jobId, companyId: company.id } },
      data: { status: "RUNNING" },
    });

    // 1社あたり最大 PER_COMPANY_TIMEOUT_MS (3分) のハードキャップ。
    // 各 submitForm 呼び出しに「残り時間」を渡し、超過時は最終画面を撮影した TIMEOUT を
    // 返させる (外側で race して結果を捨てると スクリーンショットが残らないため)。
    type Outcome = {
      attempts: number;
      result: Awaited<ReturnType<typeof submitForm>>;
    };
    const companyDeadline = Date.now() + PER_COMPANY_TIMEOUT_MS;
    const remainingMs = () => Math.max(8_000, companyDeadline - Date.now());
    const outOfTime = () => Date.now() >= companyDeadline;

    // 指定の入力 (本文) で最大 maxAttempts 回まで送信を試みる。
    const attemptLoop = async (
      attemptInput: FormInput,
      maxAttempts: number,
      labelSuffix: string,
    ): Promise<Outcome> => {
      let attempts = 0;
      let last: Awaited<ReturnType<typeof submitForm>> = {
        status: "failed",
        errorType: "UNKNOWN",
        errorMessage: "未実行",
      };
      // 適応リトライ: 直前の失敗原因に応じて次回の入力を変える。
      //  - VALIDATION_ERROR → 全角必須欄での半角混入が疑われるため、氏名/会社/住所を全角化。
      let current = attemptInput;
      let fullWidthTried = false;
      for (let i = 0; i < maxAttempts; i++) {
        if (outOfTime()) break;
        attempts++;
        const screenshotPath = screenshotDir
          ? join(screenshotDir, `${sanitizeName(company.name)}_${labelSuffix}${i + 1}.png`)
          : undefined;
        try {
          last = await submitForm(company.formUrl, current, {
            screenshotPath,
            timeoutMs: remainingMs(),
          });
          if (last.status === "success") break;
        } catch (e) {
          last = {
            status: "failed",
            errorType: "UNKNOWN",
            errorMessage: (e as Error).message,
          };
        }
        // バリデーション失敗なら、次回は全角化した入力で再試行 (一度だけ)。
        if (last.errorType === "VALIDATION_ERROR" && !fullWidthTried && i + 1 < maxAttempts) {
          current = toFullWidthInput(current);
          fullWidthTried = true;
        }
      }
      return { attempts, result: last };
    };

    // 本文を変えても解消し得ない構造的失敗 (フォーム無し/項目不一致/HTTPエラー) は
    // フォールバック再送をスキップする。バリデーション/不明/送信失敗のときだけ短文で再送。
    const FALLBACK_RETRYABLE = new Set(["VALIDATION_ERROR", "UNKNOWN", "SUBMIT_FAILED"]);
    // AI 解析はフォーム構造そのものの取りこぼしにも効くため、対象を少し広げる。
    const AI_RETRYABLE = new Set([
      "VALIDATION_ERROR",
      "UNKNOWN",
      "SUBMIT_FAILED",
      "FORM_NOT_FOUND",
      "FIELD_MISMATCH",
    ]);

    const aiOpts = () => ({
      screenshotPath: screenshotDir
        ? join(screenshotDir, `${sanitizeName(company.name)}_ai.png`)
        : undefined,
      timeoutMs: remainingMs(),
    });

    // 本文(本命)→失敗かつ短文フォールバックありなら短文で再送→なお失敗なら
    // AI 解析で再送 (学習済みレシピがあれば再利用)、までを per-company 時間内で実行する。
    const runAll = async (): Promise<Outcome> => {
      const main = await attemptLoop(input, MAX_ATTEMPTS, "attempt");
      if (main.result.status === "success") return main;

      let best = main;
      let attempts = main.attempts;

      // 1) 短文フォールバック
      const fb = job.fallbackMessageTemplate;
      if (fb && !outOfTime() && FALLBACK_RETRYABLE.has(main.result.errorType ?? "")) {
        const fbInput: FormInput = {
          ...input,
          subject: applyVars(fb.subject, company.name),
          message: applyVars(fb.body, company.name),
        };
        const fallback = await attemptLoop(fbInput, MAX_ATTEMPTS, "fallback");
        attempts += fallback.attempts;
        if (fallback.result.status === "success") return { attempts, result: fallback.result };
        if (fallback.result.screenshot && !best.result.screenshot) best = fallback;
      }

      // 2) AI フォーム解析による再送 (フェーズC: 学習済みレシピを優先再利用)。
      if (isAIFormAnalyzerEnabled() && AI_RETRYABLE.has(best.result.errorType ?? "")) {
        const domain = domainOf(company.formUrl);
        const recipe = domain ? await loadRecipe(domain) : null;

        // (a) 学習済みレシピがあれば Claude を呼ばず再利用
        if (recipe && !outOfTime()) {
          try {
            const ai = await submitFormWithAI(company.formUrl, input, aiOpts(), recipe);
            attempts += 1;
            if (ai.status === "success") {
              if (domain) await recordRecipeOutcome(domain, true, ai.recipe ?? recipe);
              return { attempts, result: ai };
            }
            if (domain) await recordRecipeOutcome(domain, false);
            if (ai.screenshot && !best.result.screenshot) best = { attempts, result: ai };
          } catch (e) {
            console.warn(`[worker] AI(recipe) failed for ${company.name}:`, (e as Error).message);
          }
        }

        // (b) レシピ無し or レシピ失敗 → Claude で新規生成し、成功すれば学習保存
        if (!outOfTime()) {
          try {
            const ai = await submitFormWithAI(company.formUrl, input, aiOpts());
            attempts += 1;
            if (ai.status === "success") {
              if (domain && ai.recipe) await recordRecipeOutcome(domain, true, ai.recipe);
              return { attempts, result: ai };
            }
            if (ai.screenshot && !best.result.screenshot) best = { attempts, result: ai };
          } catch (e) {
            console.warn(`[worker] AI(fresh) failed for ${company.name}:`, (e as Error).message);
          }
        }
      }

      return { attempts, result: best.result };
    };

    // 安全網: submitForm 内部のデッドラインが効かない箇所 (ブラウザのコンテキスト/ページ
    // 生成、レシピのDB呼び出し等) でハングしても 1社で固まらないよう、runAll 全体を
    // ハードキャップで race する。通常は内部デッドライン (スクショ付き) が先に効くため、
    // ここが発火するのは想定外ハング時のみ。
    const HARD_CAP_MS = PER_COMPANY_TIMEOUT_MS + 60_000;
    const safetyTimeout = new Promise<Outcome>((resolve) =>
      setTimeout(
        () =>
          resolve({
            attempts: 0,
            result: {
              status: "failed",
              errorType: "TIMEOUT",
              errorMessage: `1社あたりの最大処理時間 (安全網 ${HARD_CAP_MS / 1000}秒) を超過しました。`,
            },
          }),
        HARD_CAP_MS,
      ),
    );
    const { attempts: attemptsUsed, result: finalResult } = await Promise.race([
      runAll(),
      safetyTimeout,
    ]);

    // 安全網が発火した = ブラウザ生成やDB等で想定外ハングが起きた可能性が高い。
    // 次の社に持ち越さないようブラウザを作り直す。
    if (finalResult.errorType === "TIMEOUT" && finalResult.errorMessage?.includes("安全網")) {
      console.warn(`[worker] safety timeout for ${company.name}; recycling browser`);
      await closeBrowser().catch(() => null);
    }

    if (finalResult?.status === "success") {
      successCount++;
      await prisma.deliveryResult.update({
        where: { jobId_companyId: { jobId, companyId: company.id } },
        data: {
          status: "SUCCESS",
          attempts: attemptsUsed,
          attemptedAt: new Date(),
          httpStatus: finalResult.httpStatus ?? null,
          errorType: null,
          errorMessage: null,
          screenshot: finalResult.screenshot ? new Uint8Array(finalResult.screenshot) : null,
        },
      });
    } else {
      failedCount++;
      await prisma.deliveryResult.update({
        where: { jobId_companyId: { jobId, companyId: company.id } },
        data: {
          status: "FAILED",
          attempts: attemptsUsed,
          attemptedAt: new Date(),
          httpStatus: finalResult?.httpStatus ?? null,
          errorType: finalResult?.errorType ?? "UNKNOWN",
          errorMessage: finalResult?.errorMessage ?? "不明なエラー",
          screenshot: finalResult?.screenshot ? new Uint8Array(finalResult.screenshot) : null,
        },
      });
    }

    await prisma.deliveryJob.update({
      where: { id: jobId },
      data: { successCount, failedCount, skippedCount },
    });

    await new Promise((r) => setTimeout(r, INTER_COMPANY_DELAY_MS));
  }

  await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { status: "DONE", completedAt: new Date() },
  });
  console.log(
    `[worker] job ${jobId} done: success=${successCount} failed=${failedCount} skipped=${skippedCount}`,
  );
}
