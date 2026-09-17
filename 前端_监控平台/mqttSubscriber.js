const mqtt = require('mqtt');
const dataStorage = require('./dataStorage');

const config = {
  deviceId: process.env.DEVICE_ID || '69fd9d23cbb0cf6bb958c9d0_YUESE001',
  endpoint: process.env.IOTDA_DEVICE_ENDPOINT || 'ec8501a872.st1.iotda-device.cn-north-4.myhuaweicloud.com',
  port: 1883
};

let mqttClient = null;
let onDataCallback = null;

function generateClientId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `${config.deviceId}_${timestamp}_${random}`;
}

function start(callback) {
  onDataCallback = callback;
  
  const clientId = generateClientId();
  const username = config.deviceId;
  const password = '';
  
  const connectUrl = `mqtt://${config.endpoint}:${config.port}`;
  
  console.log('========================================');
  console.log('  启动MQTT订阅监听设备数据');
  console.log('========================================');
  console.log('设备ID:', config.deviceId);
  console.log('MQTT服务器:', connectUrl);
  console.log('========================================\n');
  
  const options = {
    clientId: clientId,
    username: username,
    password: password,
    keepalive: 60,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 30000
  };
  
  mqttClient = mqtt.connect(connectUrl, options);
  
  mqttClient.on('connect', () => {
    console.log('✓ MQTT连接成功');
    
    const reportTopic = `$oc/devices/${config.deviceId}/sys/properties/report`;
    
    mqttClient.subscribe(reportTopic, { qos: 1 }, (err) => {
      if (err) {
        console.error('✗ 订阅失败:', err);
      } else {
        console.log('✓ 已订阅Topic:', reportTopic);
        console.log('  等待设备上报数据...\n');
      }
    });
    
    const shadowTopic = `$oc/devices/${config.deviceId}/sys/shadow/down/get`;
    mqttClient.subscribe(shadowTopic, { qos: 1 }, (err) => {
      if (!err) {
        console.log('✓ 已订阅设备影子Topic');
      }
    });
  });
  
  mqttClient.on('message', (topic, message) => {
    try {
      console.log('\n---------- 收到MQTT消息 ----------');
      console.log('时间:', new Date().toLocaleString('zh-CN'));
      console.log('Topic:', topic);
      
      const payload = message.toString();
      console.log('原始消息:', payload);
      
      const data = JSON.parse(payload);
      
      if (topic.includes('/sys/properties/report')) {
        handlePropertiesReport(data);
      } else if (topic.includes('/sys/shadow')) {
        handleShadowUpdate(data);
      }
      
      console.log('----------------------------------\n');
    } catch (error) {
      console.error('✗ 解析消息失败:', error.message);
    }
  });
  
  mqttClient.on('error', (err) => {
    console.error('✗ MQTT错误:', err.message);
  });
  
  mqttClient.on('close', () => {
    console.log('⚠ MQTT连接已关闭');
  });
  
  mqttClient.on('reconnect', () => {
    console.log('⚠ MQTT正在重连...');
  });
}

function handlePropertiesReport(data) {
  console.log('处理属性上报数据...');
  
  if (data.services && Array.isArray(data.services)) {
    data.services.forEach(service => {
      if (service.properties) {
        const temperature = service.properties.temperature;
        const sensorId = service.properties.sensor_id;
        
        if (temperature !== undefined && temperature !== null) {
          console.log('✓ 温度:', temperature, '°C');
          console.log('✓ 传感器ID:', sensorId);
          console.log('✓ 服务ID:', service.service_id);
          
          const recordId = dataStorage.insertTemperatureData(
            config.deviceId,
            sensorId,
            temperature,
            data
          );
          
          console.log('✓ 数据已保存, ID:', recordId);
          
          if (onDataCallback) {
            onDataCallback({
              temperature: temperature,
              sensorId: sensorId,
              serviceId: service.service_id,
              deviceId: config.deviceId,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    });
  }
}

function handleShadowUpdate(data) {
  console.log('处理设备影子更新...');
  
  if (data.shadow && Array.isArray(data.shadow)) {
    data.shadow.forEach(shadow => {
      if (shadow.reported && shadow.reported.properties) {
        const props = shadow.reported.properties;
        const temperature = props.temperature;
        const sensorId = props.sensor_id;
        
        if (temperature !== undefined && temperature !== null) {
          console.log('✓ 设备影子温度:', temperature, '°C');
          
          dataStorage.insertTemperatureData(
            config.deviceId,
            sensorId,
            temperature,
            data
          );
          
          if (onDataCallback) {
            onDataCallback({
              temperature: temperature,
              sensorId: sensorId,
              deviceId: config.deviceId,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    });
  }
}

function stop() {
  if (mqttClient) {
    mqttClient.end();
    mqttClient = null;
    console.log('MQTT订阅已停止');
  }
}

module.exports = {
  start,
  stop,
  config
};
