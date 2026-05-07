# ============================================================
# Worker (apps/worker) — Playwright + Prisma + pg-boss
# Deploy target: Railway / Render / Fly.io / any Docker host
# ============================================================
FROM node:20-bookworm-slim

# Playwright (Chromium) のシステム依存
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libnss3 libnspr4 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 \
    libgtk-3-0 libxshmfence1 \
    wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# モノレポの package.json と Prisma schema を先にコピー (キャッシュ効率化 + postinstall 用)
COPY package*.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma

# 依存をインストール (postinstall で prisma generate も走る)
RUN npm ci --include=dev

# 残りのソースをコピー
COPY . .

# Playwright Chromium バイナリ取得
RUN npx -w @mvp/worker playwright install --with-deps chromium

ENV NODE_ENV=production
# Railway/Render は環境変数を直接注入するので dotenv-cli は使わない
CMD ["npx", "tsx", "apps/worker/src/index.ts"]
