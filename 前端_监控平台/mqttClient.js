const core = require('@huaweicloud/huaweicloud-sdk-core');
const iotda = require("@huaweicloud/huaweicloud-sdk-iotda/v5/public-api");
const dataStorage = require('./dataStorage');

function startDataPolling() {
  console.log('\n========================================');
  console.log('  华为云IoTDA SDK查询');
  console.log('========================================\n');
  
  const ak = 'HPUAFXXSG0YMMIMU6WGD';
  const sk = '1Kka8tWzfjpo4384KuLBcModlGLVOzjysQeLNgY';
  const projectId = '019e06a27ea47ab6a9939949b6df62c4';
  const deviceId = '69fd9d23cbb0cf6bb958c9d0_YUESE001';
  const endpoint = 'https://iotda.cn-north-4.myhuaweicloud.com';
  
  console.log('✓ AccessKey:', ak);
  console.log('✓ 项目ID:', projectId);
  console.log('✓ 设备ID:', deviceId);
  console.log('✓ Endpoint:', endpoint);
  console.log('========================================\n');
  
  const credentials = new core.BasicCredentials()
    .withAk(ak)
    .withSk(sk)
    .withProjectId(projectId);
  
  const client = iotda.IoTDAClient.newBuilder()
    .withCredential(credentials)
    .withEndpoint(endpoint)
    .build();
  
  let lastTemp = null;
  let count = 0;
  
  const query = async () => {
    try {
      count++;
      console.log(`\n[查询 ${count}] ${new Date().toLocaleString('zh-CN')}`);
      console.log('正在查询设备影子...');
      
      const request = new iotda.ShowDeviceShadowRequest();
      request.deviceId = deviceId;
      
      const response = await client.showDeviceShadow(request);
      
      console.log('✓ 查询成功!');
      
      const shadow = response.shadow;
      if (shadow && Array.isArray(shadow)) {
        shadow.forEach(s => {
          if (s.reported && s.reported.properties) {
            const props = s.reported.properties;
            const sensorId = props['sensor_id'];
            const temperature = props['temperature'];
            
            if (sensorId && temperature !== undefined) {
              console.log('✓ 传感器ID:', sensorId);
              console.log('✓ 温度值:', temperature, '°C');
              
              if (temperature !== lastTemp) {
                const recordId = dataStorage.insertTemperatureData(
                  deviceId,
                  sensorId,
                  temperature,
                  { shadow: shadow }
                );
                console.log('✓ 数据已保存, ID:', recordId);
                lastTemp = temperature;
              }
            }
          }
        });
      }
    } catch (error) {
      console.error('✗ 查询失败:', error.message || JSON.stringify(error));
    }
  };
  
  query();
  setInterval(query, 10000);
}

module.exports = { startDataPolling };
