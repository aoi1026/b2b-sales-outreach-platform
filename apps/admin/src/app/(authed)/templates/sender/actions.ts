"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().min(1).max(120),
  companyName: z.string().min(1).max(200),
  personName: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional(),
  postalCode: z.string().max(20).optional(),
  address: z.string().max(300).optional(),
  url: z.string().url().max(500).optional().or(z.literal("")),
});

function parse(formData: FormData) {
  return schema.safeParse({
    name: formData.get("name")?.toString() ?? "",
    companyName: formData.get("companyName")?.toString() ?? "",
    personName: formData.get("personName")?.toString() ?? "",
    email: formData.get("email")?.toString() ?? "",
    phone: formData.get("phone")?.toString() || undefined,
    postalCode: formData.get("postalCode")?.toString() || undefined,
    address: formData.get("address")?.toString() || undefined,
    url: formData.get("url")?.toString() ?? "",
  });
}

function normalize(d: z.infer<typeof schema>) {
  return {
    name: d.name,
    companyName: d.companyName,
    personName: d.personName,
    email: d.email,
    phone: d.phone || null,
    postalCode: d.postalCode || null,
    address: d.address || null,
    url: d.url || null,
  };
}

export async function createSenderTemplateAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = parse(formData);
  if (!parsed.success) return;
  const created = await prisma.senderTemplate.create({ data: normalize(parsed.data) });
  revalidatePath("/templates/sender");
  redirect(`/templates/sender/${created.id}`);
}

export async function updateSenderTemplateAction(
  id: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = parse(formData);
  if (!parsed.success) return;
  await prisma.senderTemplate.update({ where: { id }, data: normalize(parsed.data) });
  revalidatePath("/templates/sender");
  revalidatePath(`/templates/sender/${id}`);
  redirect(`/templates/sender/${id}`);
}

export async function deleteSenderTemplateAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.senderTemplate.delete({ where: { id } });
  revalidatePath("/templates/sender");
  redirect("/templates/sender");
}

export async function duplicateSenderTemplateAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const src = await prisma.senderTemplate.findUnique({ where: { id } });
  if (!src) return;
  const created = await prisma.senderTemplate.create({
    data: {
      name: `${src.name} (コピー)`,
      companyName: src.companyName,
      personName: src.personName,
      email: src.email,
      phone: src.phone,
      postalCode: src.postalCode,
      address: src.address,
      url: src.url,
    },
  });
  revalidatePath("/templates/sender");
  redirect(`/templates/sender/${created.id}`);
}
