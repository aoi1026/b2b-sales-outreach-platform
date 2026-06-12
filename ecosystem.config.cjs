// PM2 process manager config — さくらのVPS native deploy.
// Run from repo root:  pm2 start ecosystem.config.cjs
// All three apps load env from the root .env via dotenv-cli in their npm scripts.
module.exports = {
  apps: [
    {
      name: "mvp-admin", // 管理画面 (Next.js) :3002
      cwd: __dirname,
      script: "npm",
      args: "run start:admin",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "512M",
    },
    {
      name: "mvp-lp", // LP + ダミーフォーム (Next.js) :3001
      cwd: __dirname,
      script: "npm",
      args: "run start:lp",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "512M",
    },
    {
      name: "mvp-worker", // 送信ワーカー (Playwright + pg-boss) 常駐
      cwd: __dirname,
      script: "npm",
      args: "run start:worker",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "1G",
    },
  ],
};
