import bcrypt from "bcryptjs";
import { PrismaClient } from "../generated/prisma/index.js";

const prisma = new PrismaClient();

async function main() {
  const email = process.env["SEED_ADMIN_EMAIL"] ?? "admin@example.com";
  const password = process.env["SEED_ADMIN_PASSWORD"] ?? "admin1234";
  const name = process.env["SEED_ADMIN_NAME"] ?? "管理者";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`[seed] admin user already exists: ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, name, passwordHash },
  });
  console.log(`[seed] created admin user: ${user.email} / ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
