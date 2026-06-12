-- 送信元テンプレートに MIKOMERU 自動送信画面と同粒度の項目を追加 (すべて nullable / 後方互換)
ALTER TABLE "sender_templates"
  ADD COLUMN IF NOT EXISTS "family_name"      TEXT,
  ADD COLUMN IF NOT EXISTS "given_name"       TEXT,
  ADD COLUMN IF NOT EXISTS "family_name_kana" TEXT,
  ADD COLUMN IF NOT EXISTS "given_name_kana"  TEXT,
  ADD COLUMN IF NOT EXISTS "department"       TEXT,
  ADD COLUMN IF NOT EXISTS "position"         TEXT,
  ADD COLUMN IF NOT EXISTS "prefecture"       TEXT,
  ADD COLUMN IF NOT EXISTS "city"             TEXT,
  ADD COLUMN IF NOT EXISTS "address_line"     TEXT,
  ADD COLUMN IF NOT EXISTS "building"         TEXT;
