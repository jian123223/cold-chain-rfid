const axios = require('axios');
const vaccineStorage = require('./vaccineStorage');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'vaccine_data.json');

if (!fs.existsSync(DB_PATH)) {
  console.log('初始化数据库...');
  const initialData = {
    temperature_data: [],
    vaccine_info: {},
    alert_records: [],
    alert_confirmations: [],
    statistics: {
      daily: {},
      weekly: {},
      monthly: {}
    }
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
  console.log('✓ 数据库初始化完成');
}

const config = {
  username: process.env.IOTDA_USERNAME || 'TEST',
  password: process.env.IOTDA_PASSWORD || 'VHYVvUu9OeXVsuYZcXCf',
  domain: process.env.IOTDA_DOMAIN || 'hid_nozx10xbhh3hgxp',
  projectId: process.env.IOTDA_PROJECT_ID || '019e06a27ea47ab6a9939949b6df62c4',
  endpoint: process.env.IOTDA_APP_ENDPOINT || 'ec8501a872.st1.iotda-app.cn-north-4.myhuaweicloud.com',
  deviceId: process.env.DEVICE_ID || '69fd9d23cbb0cf6bb958c9d0_YUESE001'
};

let cachedToken = null;
let tokenExpireTime = 0;

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

  console.log('正在获取IAM Token...');
  const response = await axios.post(iamEndpoint, authData, {
    headers: { 'Content-Type': 'application/json' }
  });

  cachedToken = response.headers['x-subject-token'];
  tokenExpireTime = Date.now() + 24 * 60 * 60 * 1000;
  
  console.log('✓ Token获取成功');
  return cachedToken;
}

async function getDeviceShadow() {
  const token = await getIAMToken();
  
  const url = `https://${config.endpoint}/v5/iot/${config.projectId}/devices/${config.deviceId}/shadow`;
  
  console.log('正在获取设备影子数据...');
  const response = await axios.get(url, {
    headers: {
      'X-Auth-Token': token,
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
}

async function fetchAndSave() {
  try {
    console.log('\n========== 从华为云IoTDA获取数据 ==========');
    console.log('时间:', new Date().toLocaleString('zh-CN'));
    console.log('设备ID:', config.deviceId);
    
    const shadowData = await getDeviceShadow();
    
    console.log('\n设备影子数据:');
    console.log(JSON.stringify(shadowData, null, 2));
    
    if (shadowData && shadowData.shadow && shadowData.shadow.length > 0) {
      const reported = shadowData.shadow[0].reported;
      
      if (reported && reported.properties) {
        const props = reported.properties;
        console.log('\n解析到的属性:');
        console.log('sensor_id:', props.sensor_id);
        console.log('temperature:', props.temperature);
        console.log('temperature_1:', props.temperature_1);
        console.log('temperature_2:', props.temperature_2);
        console.log('temperature_3:', props.temperature_3);
        
        const temperatures = {};
        if (props.temperature !== undefined) temperatures.temperature = props.temperature;
        if (props.temperature_1 !== undefined) temperatures.temperature_1 = props.temperature_1;
        if (props.temperature_2 !== undefined) temperatures.temperature_2 = props.temperature_2;
        if (props.temperature_3 !== undefined) temperatures.temperature_3 = props.temperature_3;
        
        console.log('\ntemperatures对象:', JSON.stringify(temperatures));
        console.log('温度字段数量:', Object.keys(temperatures).length);
        
        const sensorId = props.sensor_id || 'UNKNOWN';
        const deviceId = shadowData.device_id || config.deviceId;
        
        if (Object.keys(temperatures).length > 0) {
          console.log('\n准备保存数据...');
          const recordId = vaccineStorage.insertTemperatureData(
            deviceId,
            sensorId,
            temperatures,
            { source: 'manual_fetch', shadow: shadowData }
          );
          
          console.log('\n✓ 数据已保存到本地数据库');
          console.log('记录ID:', recordId);
          console.log('==========================================\n');
        } else {
          console.log('\n⚠ 未找到温度数据');
        }
      } else {
        console.log('\n⚠ 设备影子中没有reported属性');
      }
    } else {
      console.log('\n⚠ 设备影子数据为空');
    }
  } catch (error) {
    console.error('\n✗ 获取失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
  }
}

fetchAndSave().then(() => {
  console.log('脚本执行完毕');
  process.exit(0);
}).catch(err => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
