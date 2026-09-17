const fs = require('fs');
const path = require('path');
const config = require('./config');

const dataPath = path.join(__dirname, 'temperature-data.json');

function loadData() {
  try {
    if (fs.existsSync(dataPath)) {
      const data = fs.readFileSync(dataPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('读取数据文件失败:', error);
  }
  return [];
}

function saveData(data) {
  try {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('保存数据文件失败:', error);
  }
}

function insertTemperatureData(deviceId, sensorId, temperature, rawData = null) {
  const data = loadData();
  const newRecord = {
    id: data.length > 0 ? Math.max(...data.map(d => d.id)) + 1 : 1,
    device_id: deviceId,
    sensor_id: sensorId,
    temperature: temperature,
    timestamp: new Date().toISOString(),
    raw_data: rawData
  };
  data.push(newRecord);
  saveData(data);
  return newRecord.id;
}

function getLatestData(deviceId, limit = 1) {
  const data = loadData();
  return data
    .filter(d => d.device_id === deviceId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

function getHistoricalData(deviceId, startTime, endTime, limit = 1000) {
  const data = loadData();
  let filtered = data.filter(d => d.device_id === deviceId);
  
  if (startTime && endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    filtered = filtered.filter(d => {
      const time = new Date(d.timestamp);
      return time >= start && time <= end;
    });
    return filtered.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).slice(0, limit);
  } else {
    return filtered
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }
}

function getDataStats(deviceId, startTime, endTime) {
  const data = loadData();
  const start = new Date(startTime);
  const end = new Date(endTime);
  
  const filtered = data.filter(d => {
    if (d.device_id !== deviceId) return false;
    const time = new Date(d.timestamp);
    return time >= start && time <= end;
  });
  
  if (filtered.length === 0) {
    return { count: 0, min_temp: null, max_temp: null, avg_temp: null };
  }
  
  const temperatures = filtered.map(d => d.temperature);
  return {
    count: filtered.length,
    min_temp: Math.min(...temperatures),
    max_temp: Math.max(...temperatures),
    avg_temp: temperatures.reduce((a, b) => a + b, 0) / temperatures.length
  };
}

function getDataCount(deviceId) {
  const data = loadData();
  return data.filter(d => d.device_id === deviceId).length;
}

module.exports = {
  insertTemperatureData,
  getLatestData,
  getHistoricalData,
  getDataStats,
  getDataCount
};
