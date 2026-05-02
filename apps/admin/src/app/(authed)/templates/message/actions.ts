"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().min(1, "テンプレート名は必須です。").max(120),
  subject: z.string().min(1, "件名は必須です。").max(200),
  body: z.string().min(1, "本文は必須です。").max(10000),
});

function parse(formData: FormData) {
  return schema.safeParse({
    name: formData.get("name")?.toString() ?? "",
    subject: formData.get("subject")?.toString() ?? "",
    body: formData.get("body")?.toString() ?? "",
  });
}

export type MessageTemplateActionResult = { error: string } | void;

export async function createMessageTemplateAction(
  formData: FormData,
): Promise<MessageTemplateActionResult> {
  const user = await requireUser();
  if (!user) return { error: "セッションが切れました。" };
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join(" / ") };
  const created = await prisma.messageTemplate.create({ data: parsed.data });
  revalidatePath("/templates/message");
  redirect(`/templates/message/${created.id}`);
}

export async function updateMessageTemplateAction(
  id: string,
  formData: FormData,
): Promise<MessageTemplateActionResult> {
  const user = await requireUser();
  if (!user) return { error: "セッションが切れました。" };
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join(" / ") };
  await prisma.messageTemplate.update({ where: { id }, data: parsed.data });
  revalidatePath("/templates/message");
  revalidatePath(`/templates/message/${id}`);
}

export async function deleteMessageTemplateAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.messageTemplate.delete({ where: { id } });
  revalidatePath("/templates/message");
  redirect("/templates/message");
}

export async function duplicateMessageTemplateAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const src = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!src) return;
  const created = await prisma.messageTemplate.create({
    data: {
      name: `${src.name} (コピー)`,
      subject: src.subject,
      body: src.body,
    },
  });
  revalidatePath("/templates/message");
  redirect(`/templates/message/${created.id}`);
}
