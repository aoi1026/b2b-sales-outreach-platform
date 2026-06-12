"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().min(1).max(120),
  companyName: z.string().min(1).max(200),
  familyName: z.string().max(60).optional(),
  givenName: z.string().max(60).optional(),
  familyNameHira: z.string().max(60).optional(),
  givenNameHira: z.string().max(60).optional(),
  familyNameKana: z.string().max(60).optional(),
  givenNameKana: z.string().max(60).optional(),
  department: z.string().max(100).optional(),
  position: z.string().max(100).optional(),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional(),
  postalCode: z.string().max(20).optional(),
  prefecture: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  addressLine: z.string().max(120).optional(),
  building: z.string().max(120).optional(),
  url: z.string().url().max(500).optional().or(z.literal("")),
});

const str = (formData: FormData, key: string) =>
  formData.get(key)?.toString() || undefined;

function parse(formData: FormData) {
  return schema.safeParse({
    name: formData.get("name")?.toString() ?? "",
    companyName: formData.get("companyName")?.toString() ?? "",
    familyName: str(formData, "familyName"),
    givenName: str(formData, "givenName"),
    familyNameHira: str(formData, "familyNameHira"),
    givenNameHira: str(formData, "givenNameHira"),
    familyNameKana: str(formData, "familyNameKana"),
    givenNameKana: str(formData, "givenNameKana"),
    department: str(formData, "department"),
    position: str(formData, "position"),
    email: formData.get("email")?.toString() ?? "",
    phone: str(formData, "phone"),
    postalCode: str(formData, "postalCode"),
    prefecture: str(formData, "prefecture"),
    city: str(formData, "city"),
    addressLine: str(formData, "addressLine"),
    building: str(formData, "building"),
    url: formData.get("url")?.toString() ?? "",
  });
}

// 半角/全角スペース区切りで結合 (空要素は除く)
const join = (...parts: (string | undefined)[]) =>
  parts.map((p) => p?.trim()).filter(Boolean).join(" ") || null;

function normalize(d: z.infer<typeof schema>) {
  const personName = join(d.familyName, d.givenName) ?? d.name; // 後方互換 (非null列)
  const personHiragana = join(d.familyNameHira, d.givenNameHira);
  const personKatakana = join(d.familyNameKana, d.givenNameKana);
  const address =
    [d.prefecture, d.city, d.addressLine, d.building]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join("") || null; // 結合住所 (後方互換 / フォーム住所欄用)
  return {
    name: d.name,
    companyName: d.companyName,
    personName,
    familyName: d.familyName || null,
    givenName: d.givenName || null,
    familyNameHira: d.familyNameHira || null,
    givenNameHira: d.givenNameHira || null,
    familyNameKana: d.familyNameKana || null,
    givenNameKana: d.givenNameKana || null,
    personHiragana,
    personKatakana,
    department: d.department || null,
    position: d.position || null,
    email: d.email,
    phone: d.phone || null,
    postalCode: d.postalCode || null,
    prefecture: d.prefecture || null,
    city: d.city || null,
    addressLine: d.addressLine || null,
    building: d.building || null,
    address,
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
      familyName: src.familyName,
      givenName: src.givenName,
      familyNameHira: src.familyNameHira,
      givenNameHira: src.givenNameHira,
      personHiragana: src.personHiragana,
      personKatakana: src.personKatakana,
      familyNameKana: src.familyNameKana,
      givenNameKana: src.givenNameKana,
      department: src.department,
      position: src.position,
      email: src.email,
      phone: src.phone,
      postalCode: src.postalCode,
      prefecture: src.prefecture,
      city: src.city,
      addressLine: src.addressLine,
      building: src.building,
      address: src.address,
      url: src.url,
    },
  });
  revalidatePath("/templates/sender");
  redirect(`/templates/sender/${created.id}`);
}
