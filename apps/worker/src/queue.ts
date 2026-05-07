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
    // pg-boss 側の自動リトライは無効化。各社の3回リトライは worker 内で行う
    retryLimit: 0,
    // ジョブ期限切れによる二重起動を防ぐためデフォルトを延長
    expireInHours: 4,
    // Supabase Free tier の session pool (15) を圧迫しないため最小化
    max: 2,
    // pg-boss のメンテナンス系を控えめに (接続消費を抑える)
    monitorStateIntervalSeconds: 60,
    maintenanceIntervalSeconds: 120,
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
