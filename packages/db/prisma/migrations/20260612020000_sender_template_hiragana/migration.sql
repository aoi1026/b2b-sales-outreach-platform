-- 送信元テンプレートに 姓/名 のひらがなフィールドを追加 (nullable / 後方互換)
ALTER TABLE "sender_templates"
  ADD COLUMN IF NOT EXISTS "family_name_hira" TEXT,
  ADD COLUMN IF NOT EXISTS "given_name_hira"  TEXT;
