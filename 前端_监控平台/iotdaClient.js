const axios = require('axios');

let cachedToken = null;
let tokenExpireTime = 0;

const config = {
  username: process.env.IOTDA_USERNAME || 'TEST',
  password: process.env.IOTDA_PASSWORD || 'VHYVvUu9OeXVsuYZcXCf',
  domain: process.env.IOTDA_DOMAIN || 'hid_nozx10xbhh3hgxp',
  projectId: process.env.IOTDA_PROJECT_ID || '019e06a27ea47ab6a9939949b6df62c4',
  endpoint: process.env.IOTDA_APP_ENDPOINT || 'ec8501a872.st1.iotda-app.cn-north-4.myhuaweicloud.com',
  deviceId: process.env.DEVICE_ID || '69fd9d23cbb0cf6bb958c9d0_YUESE001'
};

async function getIAMToken() {
  if (cachedToken && Date.now() < tokenExpireTime - 60000) {
    return cachedToken;
  }

  const iamEndpoint = 'https://iam.cn-north-4.myhuaweicloud.com/v3/auth/tokens';
  
  const authData = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: config.username,
            password: config.password,
            domain: {
              name: config.domain
            }
          }
        }
      },
      scope: {
        project: {
          id: config.projectId
        }
      }
    }
  };

  const response = await axios.post(iamEndpoint, authData, {
    headers: { 'Content-Type': 'application/json' }
  });

  cachedToken = response.headers['x-subject-token'];
  tokenExpireTime = Date.now() + 24 * 60 * 60 * 1000;
  
  return cachedToken;
}

async function getDeviceShadow() {
  const token = await getIAMToken();
  
  const url = `https://${config.endpoint}/v5/iot/${config.projectId}/devices/${config.deviceId}/shadow`;
  
  const response = await axios.get(url, {
    headers: {
      'X-Auth-Token': token,
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
}

function parseTemperature(shadowData) {
  if (!shadowData || !shadowData.shadow || shadowData.shadow.length === 0) {
    return null;
  }
  
  const reported = shadowData.shadow[0].reported;
  if (!reported || !reported.properties) {
    return null;
  }
  
  return {
    temperature: reported.properties.temperature,
    sensorId: reported.properties.sensor_id,
    eventTime: reported.event_time,
    deviceId: shadowData.device_id
  };
}

module.exports = {
  getIAMToken,
  getDeviceShadow,
  parseTemperature,
  config
};
