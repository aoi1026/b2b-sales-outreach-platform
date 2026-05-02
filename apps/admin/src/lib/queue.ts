import PgBoss from "pg-boss";

const QUEUE_DELIVERY = "delivery";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

async function getBoss(): Promise<PgBoss> {
  if (g.__mvpPgBoss) return g.__mvpPgBoss as PgBoss;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL not set");
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  await boss.start();
  await boss.createQueue(QUEUE_DELIVERY);
  g.__mvpPgBoss = boss;
  return boss;
}

export async function enqueueDeliveryJob(jobId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUE_DELIVERY, { jobId });
}
