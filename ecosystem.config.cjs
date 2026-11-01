// pm2 process file. Secrets come from .env (dotenv), never from this file.
// Start: pm2 start ecosystem.config.cjs && pm2 save   (after DISCORD_TOKEN and the GUARDIAN_* values are in .env)
module.exports = {
  apps: [{
    name: "discord-guardian",
    cwd: __dirname,
    script: "dist/index.js",
    autorestart: true,
    max_restarts: 50,
    min_uptime: "30s",
    exp_backoff_restart_delay: 2000,
    max_memory_restart: "300M",
    out_file: "data/logs/out.log",
    error_file: "data/logs/err.log",
    time: true,
  }],
};
