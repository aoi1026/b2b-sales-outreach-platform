-- ジョブ単位の URL クリック計測フラグ
ALTER TABLE "delivery_jobs"
  ADD COLUMN IF NOT EXISTS "track_url_clicks" BOOLEAN NOT NULL DEFAULT false;

-- 結果単位: 手動送信済フラグ / 行備考 / URLクリック計測
ALTER TABLE "delivery_results"
  ADD COLUMN IF NOT EXISTS "manual_sent"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "note"            TEXT,
  ADD COLUMN IF NOT EXISTS "url_clicks"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_clicked_at" TIMESTAMP(3);
