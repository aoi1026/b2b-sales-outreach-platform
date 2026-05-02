"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { saveCharPresets, saveDefaultSenderTemplateId } from "@/lib/settings";

export async function updateCharPresetsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const raw = formData.get("presets")?.toString() ?? "";
  const presets = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100000);
  await saveCharPresets(presets);
  revalidatePath("/settings");
}

export async function updateDefaultSenderTemplateAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  const id = formData.get("senderTemplateId")?.toString() || null;
  await saveDefaultSenderTemplateId(id);
  revalidatePath("/settings");
}
