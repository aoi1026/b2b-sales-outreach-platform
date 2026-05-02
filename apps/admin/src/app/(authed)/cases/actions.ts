"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { STATUS_OPTIONS } from "@/lib/case-status";
import type { CaseStatus } from "@mvp/db";

const schema = z.object({
  name: z.string().min(1, "案件名は必須です。").max(120),
  sponsor: z.string().min(1, "スポンサー名は必須です。").max(120),
  genre: z.string().max(80).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.enum(STATUS_OPTIONS as [CaseStatus, ...CaseStatus[]]),
  memo: z.string().max(2000).optional(),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    name: formData.get("name")?.toString() ?? "",
    sponsor: formData.get("sponsor")?.toString() ?? "",
    genre: formData.get("genre")?.toString() || undefined,
    startDate: formData.get("startDate")?.toString() || undefined,
    endDate: formData.get("endDate")?.toString() || undefined,
    status: (formData.get("status")?.toString() || "PREPARING") as CaseStatus,
    memo: formData.get("memo")?.toString() || undefined,
  });
}

export type CaseFormState = { error?: string } | undefined;

export async function createCaseAction(_prev: CaseFormState, formData: FormData): Promise<CaseFormState> {
  const user = await requireUser();
  if (!user) return { error: "セッションが切れました。再ログインしてください。" };

  const parsed = parseForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(" / ") };
  }
  const d = parsed.data;
  const created = await prisma.case.create({
    data: {
      name: d.name,
      sponsor: d.sponsor,
      genre: d.genre,
      startDate: d.startDate ? new Date(d.startDate) : null,
      endDate: d.endDate ? new Date(d.endDate) : null,
      status: d.status,
      memo: d.memo,
      ownerId: user.userId,
    },
  });

  revalidatePath("/cases");
  redirect(`/cases/${created.id}`);
}

export async function updateCaseAction(
  id: string,
  _prev: CaseFormState,
  formData: FormData,
): Promise<CaseFormState> {
  const user = await requireUser();
  if (!user) return { error: "セッションが切れました。再ログインしてください。" };

  const parsed = parseForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(" / ") };
  }
  const d = parsed.data;
  await prisma.case.update({
    where: { id },
    data: {
      name: d.name,
      sponsor: d.sponsor,
      genre: d.genre,
      startDate: d.startDate ? new Date(d.startDate) : null,
      endDate: d.endDate ? new Date(d.endDate) : null,
      status: d.status,
      memo: d.memo,
    },
  });

  revalidatePath("/cases");
  revalidatePath(`/cases/${id}`);
  redirect(`/cases/${id}`);
}

export async function deleteCaseAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.case.delete({ where: { id } });
  revalidatePath("/cases");
  redirect("/cases");
}

export async function duplicateCaseAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const src = await prisma.case.findUnique({ where: { id } });
  if (!src) return;
  const created = await prisma.case.create({
    data: {
      name: `${src.name} (コピー)`,
      sponsor: src.sponsor,
      genre: src.genre,
      startDate: src.startDate,
      endDate: src.endDate,
      status: "PREPARING",
      memo: src.memo,
      ownerId: user.userId,
    },
  });
  revalidatePath("/cases");
  redirect(`/cases/${created.id}`);
}
