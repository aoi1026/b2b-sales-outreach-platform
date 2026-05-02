import { prisma } from "./db";

export const DEFAULT_CHAR_PRESETS = [200, 500, 1000];

async function getJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function getCharPresets(): Promise<number[]> {
  return getJson<number[]>("charPresets", DEFAULT_CHAR_PRESETS);
}

export async function saveCharPresets(presets: number[]): Promise<void> {
  const clean = presets.filter((n) => Number.isFinite(n) && n > 0 && n <= 100000);
  await prisma.setting.upsert({
    where: { key: "charPresets" },
    update: { value: JSON.stringify(clean) },
    create: { key: "charPresets", value: JSON.stringify(clean) },
  });
}

export async function getDefaultSenderTemplateId(): Promise<string | null> {
  return getJson<string | null>("defaultSenderTemplateId", null);
}

export async function saveDefaultSenderTemplateId(id: string | null): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "defaultSenderTemplateId" },
    update: { value: JSON.stringify(id) },
    create: { key: "defaultSenderTemplateId", value: JSON.stringify(id) },
  });
}
