import pkg from "../../../packages/db/generated/prisma/index.js";
import { submitForm } from "./form-submitter.ts";
import type { DeliveryJobPayload, FormInput } from "./types.ts";

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

const INTER_COMPANY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 3;

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
      senderTemplate: true,
      results: true,
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

    const input: FormInput = {
      company: job.senderTemplate?.companyName ?? null,
      person: job.senderTemplate?.personName ?? null,
      email: job.senderTemplate?.email ?? null,
      phone: job.senderTemplate?.phone ?? null,
      subject: applyVars(job.messageTemplate.subject, company.name),
      message: applyVars(job.messageTemplate.body, company.name),
    };

    await prisma.deliveryResult.update({
      where: { jobId_companyId: { jobId, companyId: company.id } },
      data: { status: "RUNNING" },
    });

    let attemptsUsed = 0;
    let finalResult: Awaited<ReturnType<typeof submitForm>> | null = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attemptsUsed++;
      try {
        const res = await submitForm(company.formUrl, input);
        finalResult = res;
        if (res.status === "success") break;
      } catch (e) {
        finalResult = {
          status: "failed",
          errorType: "UNKNOWN",
          errorMessage: (e as Error).message,
        };
      }
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
