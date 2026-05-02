import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { createSession, destroySession, getSession } from "./session";

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { ok: false as const, error: "メールアドレスまたはパスワードが正しくありません。" };

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return { ok: false as const, error: "メールアドレスまたはパスワードが正しくありません。" };

  await createSession({ userId: user.id, email: user.email, name: user.name });
  return { ok: true as const };
}

export async function logout() {
  await destroySession();
}

export async function requireUser() {
  const session = await getSession();
  if (!session) return null;
  return session;
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}
