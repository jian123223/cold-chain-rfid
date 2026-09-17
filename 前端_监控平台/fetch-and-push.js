const axios = require('axios');

async function fetchAndPush() {
  try {
    console.log('从华为云IoTDA获取设备影子数据...');
    
    const authData = {
      auth: {
        identity: {
          methods: ['password'],
          password: {
            user: {
              name: 'TEST',
              password: 'VHYVvUu9OeXVsuYZcXCf',
              domain: { name: 'hid_nozx10xbhh3hgxp' }
            }
          }
        },
        scope: {
          project: { id: '019e06a27ea47ab6a9939949b6df62c4' }
        }
      }
    };

    const iamRes = await axios.post(
      'https://iam.cn-north-4.myhuaweicloud.com/v3/auth/tokens',
      authData,
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    const token = iamRes.headers['x-subject-token'];
    console.log('✓ Token获取成功');
    
    const shadowRes = await axios.get(
      'https://ec8501a872.st1.iotda-app.cn-north-4.myhuaweicloud.com/v5/iot/019e06a27ea47ab6a9939949b6df62c4/devices/69fd9d23cbb0cf6bb958c9d0_YUESE001/shadow',
      {
        headers: {
          'X-Auth-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const shadowData = shadowRes.data;
    console.log('✓ 设备影子获取成功');
    
    const props = shadowData.shadow[0].reported.properties;
    console.log('\n设备属性:');
    console.log('  sensor_id:', props.sensor_id);
    console.log('  temperature:', props.temperature);
    console.log('  temperature_1:', props.temperature_1);
    console.log('  temperature_2:', props.temperature_2);
    console.log('  temperature_3:', props.temperature_3);
    
    console.log('\n通过API推送到本地服务器...');
    const pushRes = await axios.post('http://localhost:3000/api/iot/push', {
      notify_data: {
        header: {
          device_id: '69fd9d23cbb0cf6bb958c9d0_YUESE001'
        },
        body: {
          services: [{
            service_id: 'DHDHGHETEG',
            properties: {
              sensor_id: props.sensor_id,
              temperature: props.temperature,
              temperature_1: props.temperature_1,
              temperature_2: props.temperature_2,
              temperature_3: props.temperature_3
            }
          }]
        }
      }
    });
    
    console.log('✓ 数据推送成功:', pushRes.data);
    
  } catch (error) {
    console.error('错误:', error.message);
    if (error.response) {
      console.error('响应:', error.response.data);
    }
  }
}

fetchAndPush();
