"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export async function attachListAction(caseId: string, formData: FormData) {
  const user = await requireUser();
  if (!user) return;
  const listId = formData.get("listId")?.toString();
  if (!listId) return;
  await prisma.caseList.upsert({
    where: { caseId_listId: { caseId, listId } },
    update: {},
    create: { caseId, listId },
  });
  revalidatePath(`/cases/${caseId}`);
}

export async function detachListAction(caseId: string, listId: string) {
  const user = await requireUser();
  if (!user) return;
  await prisma.caseList.delete({ where: { caseId_listId: { caseId, listId } } });
  revalidatePath(`/cases/${caseId}`);
}

export async function attachMessageTemplateAction(caseId: string, formData: FormData) {
  const user = await requireUser();
  if (!user) return;
  const messageTemplateId = formData.get("messageTemplateId")?.toString();
  if (!messageTemplateId) return;
  const senderTemplateId = formData.get("senderTemplateId")?.toString() || null;
  await prisma.caseTemplate.upsert({
    where: { caseId_messageTemplateId: { caseId, messageTemplateId } },
    update: { senderTemplateId },
    create: { caseId, messageTemplateId, senderTemplateId },
  });
  revalidatePath(`/cases/${caseId}`);
}

export async function updateCaseTemplateSenderAction(
  caseId: string,
  messageTemplateId: string,
  formData: FormData,
) {
  const user = await requireUser();
  if (!user) return;
  const senderTemplateId = formData.get("senderTemplateId")?.toString() || null;
  await prisma.caseTemplate.update({
    where: { caseId_messageTemplateId: { caseId, messageTemplateId } },
    data: { senderTemplateId },
  });
  revalidatePath(`/cases/${caseId}`);
}

export async function detachMessageTemplateAction(caseId: string, messageTemplateId: string) {
  const user = await requireUser();
  if (!user) return;
  await prisma.caseTemplate.delete({
    where: { caseId_messageTemplateId: { caseId, messageTemplateId } },
  });
  revalidatePath(`/cases/${caseId}`);
}
