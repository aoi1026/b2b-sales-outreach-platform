import { mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "../../../packages/db/generated/prisma/index.js";
import {
  submitForm,
  submitFormWithAI,
  isAIFormAnalyzerEnabled,
} from "./form-submitter.ts";
import type { DeliveryJobPayload, FormInput } from "./types.ts";

const prisma = new PrismaClient();

const INTER_COMPANY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 3;
// 1社あたりの全リトライ含む最大処理時間。これを超えると TIMEOUT 扱いで次社へ。
const PER_COMPANY_TIMEOUT_MS = 180_000;

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

function applyVars(text: string, companyName: string): string {
  return text
    .replace(/\{\{\s*会社名\s*\}\}/g, companyName)
    .replace(/\{\{\s*担当者名\s*\}\}/g, "ご担当者");
}

// 「山田 太郎」→ { last: "山田", first: "太郎" }
// 半角/全角スペースで分割。スペース無しは全体を last_name 扱い
function splitJapaneseName(fullName: string | null | undefined): {
  last: string | null;
  first: string | null;
} {
  if (!fullName) return { last: null, first: null };
  const parts = fullName.split(/[\s　]+/).filter(Boolean);
  if (parts.length >= 2) {
    return { last: parts[0]!, first: parts.slice(1).join(" ") };
  }
  return { last: fullName, first: null };
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
    const { last: personLast, first: personFirst } = splitJapaneseName(personName);

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
    // リトライ全体を一つの Promise として race し、タイムアウトしたら TIMEOUT で次社へ。
    type Outcome = {
      attempts: number;
      result: Awaited<ReturnType<typeof submitForm>>;
    };

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
      for (let i = 0; i < maxAttempts; i++) {
        attempts++;
        const screenshotPath = screenshotDir
          ? join(screenshotDir, `${sanitizeName(company.name)}_${labelSuffix}${i + 1}.png`)
          : undefined;
        try {
          last = await submitForm(company.formUrl, attemptInput, { screenshotPath });
          if (last.status === "success") break;
        } catch (e) {
          last = {
            status: "failed",
            errorType: "UNKNOWN",
            errorMessage: (e as Error).message,
          };
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

    // 本文(本命)→失敗かつ短文フォールバックありなら短文で再送→なお失敗なら
    // AI 解析で再送、までを1つの per-company タイムアウト内で実行する。
    const runAll = async (): Promise<Outcome> => {
      const main = await attemptLoop(input, MAX_ATTEMPTS, "attempt");
      if (main.result.status === "success") return main;

      let best = main;
      let attempts = main.attempts;

      // 1) 短文フォールバック
      const fb = job.fallbackMessageTemplate;
      if (fb && FALLBACK_RETRYABLE.has(main.result.errorType ?? "")) {
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

      // 2) AI フォーム解析による再送 (最後の手段)。本文を変えても解消しない
      //    構造的失敗 (フォーム未検出・項目不一致・検証/送信失敗) に有効。
      if (
        isAIFormAnalyzerEnabled() &&
        AI_RETRYABLE.has(best.result.errorType ?? "")
      ) {
        const screenshotPath = screenshotDir
          ? join(screenshotDir, `${sanitizeName(company.name)}_ai.png`)
          : undefined;
        try {
          const ai = await submitFormWithAI(company.formUrl, input, { screenshotPath });
          attempts += 1;
          if (ai.status === "success") return { attempts, result: ai };
          if (ai.screenshot && !best.result.screenshot) best = { attempts, result: ai };
        } catch (e) {
          console.warn(`[worker] AI submit failed for ${company.name}:`, (e as Error).message);
        }
      }

      return { attempts, result: best.result };
    };

    const timeoutPromise = new Promise<Outcome>((resolve) =>
      setTimeout(
        () =>
          resolve({
            attempts: 0,
            result: {
              status: "failed",
              errorType: "TIMEOUT",
              errorMessage: `1社あたりの最大処理時間 (${PER_COMPANY_TIMEOUT_MS / 1000}秒) を超過しました。`,
            },
          }),
        PER_COMPANY_TIMEOUT_MS,
      ),
    );

    const { attempts: attemptsUsed, result: finalResult } = await Promise.race([
      runAll(),
      timeoutPromise,
    ]);

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
