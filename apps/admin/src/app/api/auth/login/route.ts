import { NextResponse } from "next/server";
import { z } from "zod";
import { login } from "@/lib/auth";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "入力内容が不正です。" }, { status: 400 });
  }
  const result = await login(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
