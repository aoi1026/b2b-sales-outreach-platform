"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import type { BlacklistType } from "@mvp/db";

const schema = z.object({
  type: z.enum(["DOMAIN", "COMPANY_NAME"]),
  value: z.string().min(1).max(300),
  reason: z.string().max(300).optional(),
});

export async function addBlacklistAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const parsed = schema.safeParse({
    type: formData.get("type")?.toString() ?? "DOMAIN",
    value: formData.get("value")?.toString()?.trim() ?? "",
    reason: formData.get("reason")?.toString() || undefined,
  });
  if (!parsed.success) return;
  const d = parsed.data;
  try {
    await prisma.blacklistEntry.create({
      data: {
        type: d.type as BlacklistType,
        value: d.type === "DOMAIN" ? d.value.toLowerCase() : d.value,
        reason: d.reason || null,
        source: "MANUAL",
      },
    });
  } catch {
    /* duplicate — silently ignore */
  }
  revalidatePath("/exclusions");
}

export async function deleteBlacklistAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.blacklistEntry.delete({ where: { id } });
  revalidatePath("/exclusions");
}
