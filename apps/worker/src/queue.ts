import PgBoss from "pg-boss";

export const QUEUE_DELIVERY = "delivery";

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  bossInstance = new PgBoss({
    connectionString,
    schema: "pgboss",
    retryLimit: 2,
    retryDelay: 30,
  });
  await bossInstance.start();
  await bossInstance.createQueue(QUEUE_DELIVERY);
  return bossInstance;
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true });
    bossInstance = null;
  }
}
