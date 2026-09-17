require('dotenv').config();

module.exports = {
  iotda: {
    accessKey: process.env.IOTDA_ACCESS_KEY,
    secretKey: process.env.IOTDA_SECRET_KEY,
    username: process.env.IOTDA_USERNAME,
    password: process.env.IOTDA_PASSWORD,
    domain: process.env.IOTDA_DOMAIN,
    endpoint: process.env.IOTDA_APP_ENDPOINT || process.env.IOTDA_ENDPOINT || 'iotda.cn-north-4.myhuaweicloud.com',
    projectId: process.env.IOTDA_PROJECT_ID,
    deviceId: process.env.DEVICE_ID || '69fd9d23cbb0cf6bb958c9d0_YUESE001'
  },
  server: {
    port: process.env.SERVER_PORT || 3000
  },
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin123'
  },
  database: {
    path: process.env.DB_PATH || './temperature.db'
  }
};
