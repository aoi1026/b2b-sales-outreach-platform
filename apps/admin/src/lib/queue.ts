import PgBoss from "pg-boss";

const QUEUE_DELIVERY = "delivery";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

async function getBoss(): Promise<PgBoss> {
  if (g.__mvpPgBoss) return g.__mvpPgBoss as PgBoss;
  // pg-boss は LISTEN/NOTIFY と prepared statement を使うため Session mode 必須
  // Prisma 用 (Transaction mode) と分けて専用 URL を持たせる
  const connectionString =
    process.env["PGBOSS_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("PGBOSS_DATABASE_URL / DATABASE_URL not set");
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    // Vercel serverless の同時インスタンス数を考慮し、最小プールに固定
    max: 1,
  });
  await boss.start();
  await boss.createQueue(QUEUE_DELIVERY);
  g.__mvpPgBoss = boss;
  return boss;
}

export async function enqueueDeliveryJob(jobId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    QUEUE_DELIVERY,
    { jobId },
    {
      // 50社×平均30秒 (Playwright + リトライ含む) でも余裕を持てるように4時間
      // pg-boss のデフォルト 15 分だと長尺ジョブが期限切れ→重複起動の原因になる
      expireInHours: 4,
      // pg-boss 側のリトライは worker 内のリトライ (各社 3 回) と二重になるので無効化
      retryLimit: 0,
    },
  );
}
