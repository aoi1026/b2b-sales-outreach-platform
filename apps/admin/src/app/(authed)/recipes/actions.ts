"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// レシピの有効/無効を切り替える (無効化すると次回は AI が作り直す)。
export async function toggleRecipeAction(id: string, enabled: boolean): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  // 手動で有効化した場合は失敗カウントもリセットして再挑戦させる。
  await prisma.formRecipe.update({
    where: { id },
    data: { enabled, ...(enabled ? { failCount: 0 } : {}) },
  });
  revalidatePath("/recipes");
}

// レシピを削除する (次回は AI がゼロから解析して再学習する)。
export async function deleteRecipeAction(id: string): Promise<void> {
  const user = await requireUser();
  if (!user) return;
  await prisma.formRecipe.delete({ where: { id } });
  revalidatePath("/recipes");
}
