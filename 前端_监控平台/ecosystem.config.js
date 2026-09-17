module.exports = {
  apps: [{
    name: 'iot-vaccine-monitor',
    script: './server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      SERVER_PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  }]
};
