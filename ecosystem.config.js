module.exports = {
  apps: [{
    name: "index",
    script: "index.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "1024M",
    restart_delay: 5000,
    max_restarts: 20,
    min_uptime: "10s",
    time: true,
    env: { NODE_ENV: "production" }
  }]
};
