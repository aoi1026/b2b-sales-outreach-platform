"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const listSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export async function updateListAction(id: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = listSchema.safeParse({
    name: formData.get("name")?.toString() ?? "",
    description: formData.get("description")?.toString() || undefined,
  });
  if (!parsed.success) return;
  await prisma.list.update({
    where: { id },
    data: { name: parsed.data.name, description: parsed.data.description ?? null },
  });
  revalidatePath("/lists");
  revalidatePath(`/lists/${id}`);
}

export async function deleteListAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.list.delete({ where: { id } });
  revalidatePath("/lists");
  redirect("/lists");
}

const companySchema = z.object({
  name: z.string().min(1).max(200),
  formUrl: z.string().url().max(500),
  siteUrl: z.string().url().max(500).optional().or(z.literal("")),
  email: z.string().email().max(200).optional().or(z.literal("")),
  industry: z.string().max(80).optional(),
});

function parseCompany(formData: FormData) {
  return companySchema.safeParse({
    name: formData.get("name")?.toString() ?? "",
    formUrl: formData.get("formUrl")?.toString() ?? "",
    siteUrl: formData.get("siteUrl")?.toString() ?? "",
    email: formData.get("email")?.toString() ?? "",
    industry: formData.get("industry")?.toString() || undefined,
  });
}

export async function addCompanyAction(listId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = parseCompany(formData);
  if (!parsed.success) return;
  const d = parsed.data;
  await prisma.company.create({
    data: {
      listId,
      name: d.name,
      formUrl: d.formUrl,
      siteUrl: d.siteUrl || null,
      email: d.email || null,
      industry: d.industry || null,
    },
  });
  revalidatePath(`/lists/${listId}`);
}

export async function updateCompanyAction(
  listId: string,
  companyId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = parseCompany(formData);
  if (!parsed.success) return;
  const d = parsed.data;
  await prisma.company.update({
    where: { id: companyId },
    data: {
      name: d.name,
      formUrl: d.formUrl,
      siteUrl: d.siteUrl || null,
      email: d.email || null,
      industry: d.industry || null,
    },
  });
  revalidatePath(`/lists/${listId}`);
  redirect(`/lists/${listId}`);
}

export async function deleteCompanyAction(listId: string, companyId: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.company.delete({ where: { id: companyId } });
  revalidatePath(`/lists/${listId}`);
}
