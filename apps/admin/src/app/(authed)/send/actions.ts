"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { enqueueDeliveryJob } from "@/lib/queue";

const MAX_COMPANIES = 220;

const createSchema = z.object({
  caseId: z.string().min(1),
  listId: z.string().min(1),
  messageTemplateId: z.string().min(1),
  fallbackMessageTemplateId: z.string().optional().or(z.literal("")),
  senderTemplateId: z.string().optional().or(z.literal("")),
  note: z.string().max(300).optional(),
  trackUrlClicks: z.string().optional(),
});

export async function createDeliveryJobAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = createSchema.safeParse({
    caseId: formData.get("caseId")?.toString() ?? "",
    listId: formData.get("listId")?.toString() ?? "",
    messageTemplateId: formData.get("messageTemplateId")?.toString() ?? "",
    fallbackMessageTemplateId: formData.get("fallbackMessageTemplateId")?.toString() ?? "",
    senderTemplateId: formData.get("senderTemplateId")?.toString() ?? "",
    note: formData.get("note")?.toString() || undefined,
    trackUrlClicks: formData.get("trackUrlClicks")?.toString() || undefined,
  });
  if (!parsed.success) return;
  const d = parsed.data;

  const list = await prisma.list.findUnique({
    where: { id: d.listId },
    include: { _count: { select: { companies: true } } },
  });
  if (!list) return;
  if (list._count.companies === 0) return;
  if (list._count.companies > MAX_COMPANIES) {
    throw new Error(
      `1ジョブあたりの上限 ${MAX_COMPANIES} 件を超えています (${list._count.companies} 件)。`,
    );
  }

  const job = await prisma.deliveryJob.create({
    data: {
      caseId: d.caseId,
      listId: d.listId,
      messageTemplateId: d.messageTemplateId,
      fallbackMessageTemplateId:
        d.fallbackMessageTemplateId && d.fallbackMessageTemplateId !== d.messageTemplateId
          ? d.fallbackMessageTemplateId
          : null,
      senderTemplateId: d.senderTemplateId || null,
      status: "PENDING",
      plannedCount: list._count.companies,
      note: d.note || null,
      trackUrlClicks: d.trackUrlClicks === "on" || d.trackUrlClicks === "true",
    },
  });

  await enqueueDeliveryJob(job.id);
  revalidatePath("/send");
  redirect(`/send/${job.id}`);
}

export async function pauseJobAction(jobId: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { pauseRequested: true },
  });
  revalidatePath(`/send/${jobId}`);
}

export async function resumeJobAction(jobId: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { pauseRequested: false, status: "PENDING" },
  });
  await enqueueDeliveryJob(jobId);
  revalidatePath(`/send/${jobId}`);
}

export async function cancelJobAction(jobId: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;

  const job = await prisma.deliveryJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!job) return;

  if (job.status === "PENDING" || job.status === "PAUSED") {
    // Worker が処理に入っていないのでその場で確定させる
    await prisma.deliveryJob.update({
      where: { id: jobId },
      data: {
        status: "CANCELLED",
        cancelRequested: true,
        completedAt: new Date(),
      },
    });
  } else {
    // RUNNING は Worker が次の会社の処理前にフラグを検知して止まる
    await prisma.deliveryJob.update({
      where: { id: jobId },
      data: { cancelRequested: true },
    });
  }
  revalidatePath(`/send/${jobId}`);
  revalidatePath("/send");
}

export async function deleteJobAction(
  jobId: string,
): Promise<{ error?: string } | void> {
  const user = await requireUser();
  if (!user) return;

  const job = await prisma.deliveryJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!job) {
    revalidatePath("/send");
    return;
  }
  if (job.status === "RUNNING") {
    return {
      error:
        "実行中のジョブは削除できません。先に「一時停止」または「キャンセル」を行ってください。",
    };
  }

  // DeliveryResult は onDelete: Cascade なので job 削除で連鎖削除される
  await prisma.deliveryJob.delete({ where: { id: jobId } });
  revalidatePath("/send");
}

// ジョブ単位の備考を更新
export async function updateJobNoteAction(
  jobId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const note = formData.get("note")?.toString().slice(0, 300) || null;
  await prisma.deliveryJob.update({ where: { id: jobId }, data: { note } });
  revalidatePath(`/send/${jobId}`);
}

// 結果行の「手動送信済」フラグをトグル
export async function toggleResultManualSentAction(
  resultId: string,
  jobId: string,
): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const r = await prisma.deliveryResult.findUnique({
    where: { id: resultId },
    select: { manualSent: true },
  });
  if (!r) return;
  await prisma.deliveryResult.update({
    where: { id: resultId },
    data: { manualSent: !r.manualSent },
  });
  revalidatePath(`/send/${jobId}`);
}

// 結果行の備考を更新
export async function updateResultNoteAction(
  resultId: string,
  jobId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const note = formData.get("note")?.toString().slice(0, 500) || null;
  await prisma.deliveryResult.update({ where: { id: resultId }, data: { note } });
  revalidatePath(`/send/${jobId}`);
}
