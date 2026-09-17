const express = require('express');
const compression = require('compression');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');
const vaccineStorage = require('./vaccineStorage');
const iotdaClient = require('./iotdaClient');

const app = express();

// Gzip/Brotli 压缩（放在最前面）
app.use(compression({ threshold: 1024 }));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE']
}));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

const DEFAULT_TEMP_MIN = 2;
const DEFAULT_TEMP_MAX = 8;

function getTagThreshold(key) {
  const info = vaccineStorage.getVaccineInfo(key) || {};
  const min = parseFloat(info.temp_min);
  const max = parseFloat(info.temp_max);
  return {
    min: isNaN(min) ? DEFAULT_TEMP_MIN : min,
    max: isNaN(max) ? DEFAULT_TEMP_MAX : max
  };
}

// ======================== 认证系统 ========================
// token -> { userId, role, username, expiresAt }
const authTokens = new Map();

// 从已登录用户获取用户名
function getUsername(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  const session = authTokens.get(token);
  return session ? session.username : null;
}

// 普通用户认证（需登录，任何角色）
function userAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !authTokens.has(token)) {
    return res.status(401).json({ success: false, error: '未授权，请先登录' });
  }
  const session = authTokens.get(token);
  if (Date.now() > session.expiresAt) {
    authTokens.delete(token);
    return res.status(401).json({ success: false, error: '登录已过期' });
  }
  req._auth = session;
  next();
}

// 管理员认证（需管理员或超级管理员角色）
function adminAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !authTokens.has(token)) {
    return res.status(401).json({ success: false, error: '未授权，请先登录' });
  }
  const session = authTokens.get(token);
  if (Date.now() > session.expiresAt) {
    authTokens.delete(token);
    return res.status(401).json({ success: false, error: '登录已过期' });
  }
  if (session.role !== 'admin' && session.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: '权限不足，需要管理员权限' });
  }
  req._auth = session;
  next();
}

// 超级管理员认证
function superAdminAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !authTokens.has(token)) {
    return res.status(401).json({ success: false, error: '未授权，请先登录' });
  }
  const session = authTokens.get(token);
  if (Date.now() > session.expiresAt) {
    authTokens.delete(token);
    return res.status(401).json({ success: false, error: '登录已过期' });
  }
  if (session.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: '权限不足，需要超级管理员权限' });
  }
  req._auth = session;
  next();
}

// 定时清理过期 token
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of authTokens) {
    if (now > s.expiresAt) authTokens.delete(t);
  }
}, 60000);

// 登录
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请输入账号和密码' });
  }
  const user = vaccineStorage.getUserByUsername(username);
  if (!user || user.password !== password) {
    return res.status(401).json({ success: false, error: '账号或密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    zeren: user.zeren,
    duty: user.duty || '',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  });
  vaccineStorage.addOperationLog({
    user: username, action: 'login', target: 'auth',
    detail: `用户登录`, ip: req.ip
  });
  res.json({ success: true, token, role: user.role, username: user.username, zeren: user.zeren, duty: user.duty || '', responsibility: user.responsibility || '' });
});

// 登出
app.post('/api/auth/logout', userAuth, (req, res) => {
  const token = req.headers['x-auth-token'];
  authTokens.delete(token);
  res.json({ success: true, message: '已登出' });
});

// 获取当前用户信息
app.get('/api/auth/me', userAuth, (req, res) => {
  res.json({ success: true, username: req._auth.username, role: req._auth.role, zeren: req._auth.zeren, duty: req._auth.duty || '' });
});

// ======================== 用户管理（管理员） ========================
app.get('/api/admin/users', adminAuth, (req, res) => {
  try {
    const users = vaccineStorage.getAllUsers();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/users', adminAuth, (req, res) => {
  try {
    const { username, password, role, zeren, duty, responsibility } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: '用户名和密码不能为空' });
    }
    // 只有超级管理员能创建管理员账号
    if (role === 'admin' && req._auth.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: '权限不足，只有超级管理员才能创建管理员账号' });
    }
    const user = vaccineStorage.createUser(username, password, role || 'user', { zeren, duty, responsibility });
    if (!user) {
      return res.status(400).json({ success: false, error: '用户名已存在' });
    }
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'create_user', target: username,
      detail: `创建用户: ${username} (${role || 'user'})`, ip: req.ip
    });
    res.json({ success: true, data: user, message: '用户创建成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/admin/users/:id', adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { password, role, zeren, duty, responsibility } = req.body;
    // 只有超级管理员可以修改管理员信息
    const targetUser = vaccineStorage.getUserById(id);
    if (targetUser && (targetUser.role === 'admin' || targetUser.role === 'super_admin') && req._auth.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: '权限不足，只有超级管理员才能修改管理员信息' });
    }
    const updates = { password, role };
    if (zeren !== undefined) updates.zeren = zeren;
    if (duty !== undefined) updates.duty = duty;
    if (responsibility !== undefined) updates.responsibility = responsibility;
    const user = vaccineStorage.updateUser(id, updates);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'update_user', target: user.username,
      detail: `修改用户: ${user.username} (角色:${role || '不变'}, ${password ? '密码已修改' : '密码未改'})`, ip: req.ip
    });
    res.json({ success: true, data: user, message: '用户更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const user = vaccineStorage.getUserById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }
    if (user.username === 'admin') {
      return res.status(400).json({ success: false, error: '不能删除超级管理员账号' });
    }
    // 只有超级管理员可以删除管理员
    if ((user.role === 'admin' || user.role === 'super_admin') && req._auth.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: '权限不足，只有超级管理员才能删除管理员账号' });
    }
    vaccineStorage.deleteUser(id);
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'delete_user', target: user.username,
      detail: `删除用户: ${user.username}`, ip: req.ip
    });
    res.json({ success: true, message: '用户已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 根据 zeren 编号查询负责人
app.get('/api/admin/responsible/:zeren', (req, res) => {
  try {
    const zeren = parseInt(req.params.zeren);
    if (isNaN(zeren)) return res.status(400).json({ success: false, error: '无效的zeren编号' });
    const user = vaccineStorage.getUserByZeren(zeren);
    if (!user) {
      return res.json({ success: true, data: null, message: '未找到该编号对应的管理员' });
    }
    res.json({ success: true, data: { zeren: user.zeren, username: user.username, duty: user.duty || '', responsibility: user.responsibility || '' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== 任务安排（超级管理员） ========================
// 获取所有管理员任务安排
app.get('/api/admin/tasks', superAdminAuth, (req, res) => {
  try {
    const users = vaccineStorage.getAllUsers();
    const admins = users.filter(u => u.role === 'admin' || u.role === 'super_admin');
    res.json({ success: true, data: admins });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 分配/更新单个管理员任务
app.put('/api/admin/tasks/assign', superAdminAuth, (req, res) => {
  try {
    const { userId, zeren, duty, responsibility } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: '缺少 userId' });
    const targetUser = vaccineStorage.getUserById(userId);
    if (!targetUser) return res.status(404).json({ success: false, error: '用户不存在' });
    if (targetUser.role !== 'admin') return res.status(400).json({ success: false, error: '只能给管理员分配任务' });
    
    const updates = {};
    if (zeren !== undefined) updates.zeren = parseInt(zeren);
    if (duty !== undefined) updates.duty = duty;
    if (responsibility !== undefined) updates.responsibility = responsibility;
    
    const user = vaccineStorage.updateUser(userId, updates);
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'assign_task', target: user.username,
      detail: `分配任务: ${user.username} (编号:${zeren}, 职责:${duty}, 责任心:${responsibility})`, ip: req.ip
    });
    res.json({ success: true, data: user, message: '任务分配成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 批量分配任务（方便快速调整值班轮换）
app.put('/api/admin/tasks/assign-batch', superAdminAuth, (req, res) => {
  try {
    const { assignments } = req.body; // [{userId, zeren, duty, responsibility}, ...]
    if (!Array.isArray(assignments)) return res.status(400).json({ success: false, error: 'assignments 必须是数组' });
    const results = [];
    for (const item of assignments) {
      const targetUser = vaccineStorage.getUserById(item.userId);
      if (!targetUser || targetUser.role !== 'admin') continue;
      const updates = {};
      if (item.zeren !== undefined) updates.zeren = parseInt(item.zeren);
      if (item.duty !== undefined) updates.duty = item.duty;
      if (item.responsibility !== undefined) updates.responsibility = item.responsibility;
      const user = vaccineStorage.updateUser(item.userId, updates);
      results.push(user);
    }
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'assign_batch_task', target: 'batch',
      detail: `批量分配 ${results.length} 个管理员任务`, ip: req.ip
    });
    res.json({ success: true, data: results, message: `已为 ${results.length} 个管理员分配任务` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== 操作日志（管理员） ========================
app.get('/api/admin/operation-logs', adminAuth, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const startTime = req.query.startTime || null;
    const endTime = req.query.endTime || null;
    const action = req.query.action || null;
    const user = req.query.user || null;
    const result = vaccineStorage.getOperationLogs(page, pageSize, startTime, endTime, action, user);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== 原始推送日志（需登录） ========================
app.get('/api/admin/raw-logs', userAuth, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    // 支持 datetime-local 格式（精确到秒），也兼容只有日期
    const startTime = req.query.startTime || null;
    const endTime = req.query.endTime || null;
    const lianwang = req.query.lianwang;
    const result = vaccineStorage.getRawLogs(page, pageSize, startTime, endTime, lianwang);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/raw-logs', adminAuth, (req, res) => {
  try {
    vaccineStorage.clearRawLogs();
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'clear_logs', target: 'raw_logs',
      detail: '清空原始推送日志', ip: req.ip
    });
    res.json({ success: true, message: '日志已清空' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== IoTDA 推送 ========================
const IOT_PUSH_TOKEN = process.env.IOT_PUSH_TOKEN || '';
const sseClients = new Set(); // SSE 客户端连接池

function iotPushAuth(req, res, next) {
  if (IOT_PUSH_TOKEN) {
    const timestamp = req.headers['timestamp'] || '';
    const nonce = req.headers['nonce'] || '';
    const signature = req.headers['signature'] || '';
    if (!timestamp && !nonce && !signature) {
      const directToken = req.headers['x-auth-token'] || req.query.token || '';
      if (directToken === IOT_PUSH_TOKEN) return next();
      console.log('⚠ IoT推送Token验证失败（既无签名头也无直接Token）');
      return res.status(403).json({ success: false, error: 'Token验证失败' });
    }
    const list = [IOT_PUSH_TOKEN, timestamp, nonce].sort();
    const raw = list.join('');
    const computed = crypto.createHash('sha256').update(raw).digest('hex');
    if (computed !== signature) {
      console.log(`⚠ IoT推送签名验证失败`);
      return res.status(403).json({ success: false, error: '签名验证失败' });
    }
  }
  next();
}

app.post('/api/iot/push', iotPushAuth, async (req, res) => {
  try {
    console.log('\n========== 收到华为云数据推送 ==========');
    console.log('时间:', new Date().toLocaleString('zh-CN'));
    console.log('Content-Type:', req.headers['content-type']);
    console.log('body type:', typeof req.body);
    console.log('body keys:', req.body ? Object.keys(req.body).join(',') : 'NULL');
    
    const body = req.body;
    let deviceId = null;
    let sensorId = null;
    let temperatures = {};
    let dingweiValue = null;
    let lianwang = null;
    let zeren = null;
    let eventTime = null;

    function extractProps(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(item => extractProps(item)); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'device_id' && typeof v === 'string') deviceId = v;
        if (k === 'deviceId' && typeof v === 'string') deviceId = v;
        if (k === 'sensor_id' && typeof v === 'string') sensorId = v;
        if (k === 'dingwei' && typeof v === 'string') dingweiValue = v;
        if (k === 'lianwang' && (typeof v === 'number' || typeof v === 'string')) lianwang = parseInt(v);
        if (k === 'zeren' && (typeof v === 'number' || typeof v === 'string')) zeren = parseInt(v);
        if (k === 'eventTime' && typeof v === 'string') eventTime = v;
        if (typeof v === 'number' && !['app_id','request_id','product_id','gateway_id','event_time_ms','lianwang','zeren'].includes(k)) {
          temperatures[k] = v;
        }
        if (typeof v === 'object' && k !== 'header') extractProps(v);
      }
    }
    extractProps(body);
    deviceId = deviceId || config.iotda.deviceId;

    const tempKeys = Object.keys(temperatures);
    
    // 处理温度数据
    if (tempKeys.length > 0) {
      console.log('✓ 设备ID:', deviceId);
      console.log('✓ 温度数据:', temperatures);
      console.log('✓ 联网状态:', lianwang === 1 ? '实时' : lianwang === 0 ? '断网补传' : '未知');
      const recordId = vaccineStorage.insertTemperatureData(deviceId, sensorId || 'UNKNOWN', temperatures, body, lianwang, zeren, eventTime);
      
      // 断网重传报警
      if (lianwang === 0) {
        const tempList = Object.entries(temperatures).map(([k, v]) => `${vaccineStorage.getVaccineInfo(k)?.name || k}: ${v}°C`).join(', ');
        vaccineStorage.addAlertRecord({
          sensor_id: sensorId || 'UNKNOWN', device_id: deviceId,
          alert_type: 'offline_retransmit',
          type: 'offline',
          message: `设备断网数据重传 - ${tempList}`,
          is_offline: true
        });
      }
      
      // 温度阈值报警
      for (const [key, temp] of Object.entries(temperatures)) {
        const threshold = getTagThreshold(key);
        if (temp < threshold.min || temp > threshold.max) {
          const label = vaccineStorage.getVaccineInfo(key)?.name || key;
          vaccineStorage.addAlertRecord({
            sensor_id: sensorId || 'UNKNOWN', device_id: deviceId,
            alert_type: 'temperature',
            temperature: temp, temperature_field: key,
            type: temp < threshold.min ? 'low' : 'high',
            message: `${label} 温度${temp < threshold.min ? '过低' : '过高'}: ${temp}°C (阈值 ${threshold.min}~${threshold.max}°C)`,
            is_offline: lianwang === 0
          });
        }
      }
    }

    // 处理定位数据
    let locationRecord = null;
    if (dingweiValue) {
      console.log('📌 检测到定位数据:', dingweiValue);
      // 反向地理编码获取地址
      let address = '';
      try {
        const parts = dingweiValue.split(',');
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          const geoRes = await axios.get('https://nominatim.openstreetmap.org/reverse', {
            params: { lat, lon: lng, format: 'json', 'accept-language': 'zh' },
            headers: { 'User-Agent': 'IoT-Vaccine-Monitor/1.0' },
            timeout: 5000
          });
          if (geoRes.data && geoRes.data.display_name) {
            address = geoRes.data.display_name;
          }
        }
      } catch (geoErr) {
        console.log('  地理编码失败:', geoErr.message);
      }
      if (address) console.log('  地址:', address);
      locationRecord = vaccineStorage.addLocationRecord(deviceId, dingweiValue, address, body);
    }

    // 始终保存原始日志
    vaccineStorage.addRawLog({ _ip: req.ip, _ts: new Date().toISOString(), _lianwang: lianwang, _zeren: zeren, ...body });
    
    // SSE 广播
    if (tempKeys.length > 0) {
      const ssePayload = JSON.stringify({ type: 'temperature', record: tempKeys.length > 0, temperatures, timestamp: new Date().toISOString(), lianwang });
      for (const client of sseClients) {
        try { client.write(`data: ${ssePayload}\n\n`); } catch (e) { sseClients.delete(client); }
      }
    }
    if (locationRecord) {
      const locPayload = JSON.stringify({ type: 'location', latitude: locationRecord.latitude, longitude: locationRecord.longitude, address: locationRecord.address, timestamp: locationRecord.timestamp });
      for (const client of sseClients) {
        try { client.write(`data: ${locPayload}\n\n`); } catch (e) { sseClients.delete(client); }
      }
    }
    
    const hasAny = tempKeys.length > 0 || locationRecord;
    if (!hasAny) {
      console.log('⚠ 无法解析数据 - body sample:', JSON.stringify(body).substring(0, 300));
      console.log('  提取结果: temps=' + tempKeys.length, 'lianwang=' + lianwang, 'zeren=' + zeren, 'sensorId=' + sensorId, 'loc=' + dingweiValue);
    }
    console.log(hasAny ? `✓ 数据处理完成` : '⚠ 无法解析数据');
    console.log('==========================================\n');
    res.json({ success: true, message: '数据接收成功' });
  } catch (error) {
    console.error('✗ 处理推送数据失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== SSE 实时推送 ========================
app.get('/api/sse/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  sseClients.add(res);
  console.log(`SSE 客户端已连接 (当前 ${sseClients.size} 个)`);

  // 心跳保活
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`SSE 客户端断开 (当前 ${sseClients.size} 个)`);
  });
});

// ======================== 公开/只读 API ========================

app.get('/api/temperature/latest', (req, res) => {
  try {
    const deviceId = req.query.deviceId || config.iotda.deviceId;
    const limit = parseInt(req.query.limit) || 100;
    const data = vaccineStorage.getLatestData(deviceId, limit);
    res.json({ success: true, data, count: data.length, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/temperature/history', (req, res) => {
  try {
    const deviceId = req.query.deviceId || config.iotda.deviceId;
    const { startTime, endTime } = req.query;
    const limit = parseInt(req.query.limit) || 10000;
    const data = vaccineStorage.getHistoricalData(deviceId, startTime, endTime, limit);
    res.json({ success: true, data, count: data.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/temperature/stats', (req, res) => {
  try {
    const deviceId = req.query.deviceId || config.iotda.deviceId;
    const startTime = req.query.startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const endTime = req.query.endTime || new Date().toISOString();
    const stats = vaccineStorage.getDataStats(deviceId, startTime, endTime);
    const totalCount = vaccineStorage.getDataCount(deviceId);
    res.json({ success: true, stats: { ...stats, totalCount } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== 位置/地图 API ========================

// 获取最新位置
app.get('/api/location/current', (req, res) => {
  try {
    const deviceId = req.query.deviceId || null;
    const location = vaccineStorage.getLatestLocation(deviceId);
    res.json({ success: true, data: location });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取位置历史（用于路线图）
app.get('/api/location/history', (req, res) => {
  try {
    const deviceId = req.query.deviceId || null;
    const limit = parseInt(req.query.limit) || 100;
    const data = vaccineStorage.getLocationHistory(deviceId, limit);
    res.json({ success: true, data, count: data.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取含 dingwei 的定位日志
app.get('/api/location/logs', adminAuth, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 30;
    const { startTime, endTime } = req.query;
    const result = vaccineStorage.getLocationLogs(page, pageSize, startTime, endTime);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 反向地理编码
app.get('/api/location/geocode', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ success: false, error: '缺少 lat/lng' });
    const geoRes = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat: parseFloat(lat), lon: parseFloat(lng), format: 'json', 'accept-language': 'zh' },
      headers: { 'User-Agent': 'IoT-Vaccine-Monitor/1.0' },
      timeout: 5000
    });
    res.json({ success: true, data: geoRes.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/vaccine/info/:sensorId', (req, res) => {
  try {
    const info = vaccineStorage.getVaccineInfo(req.params.sensorId);
    res.json({ success: true, data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/vaccine/info', (req, res) => {
  try {
    const info = vaccineStorage.getAllVaccineInfo();
    res.json({ success: true, data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/alerts', (req, res) => {
  try {
    const { startTime, endTime } = req.query;
    const confirmed = req.query.confirmed === 'true' ? true : req.query.confirmed === 'false' ? false : undefined;
    const alertType = req.query.alertType || null;
    const alerts = vaccineStorage.getAlertRecords(startTime, endTime, confirmed, alertType);
    res.json({ success: true, data: alerts, count: alerts.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alerts/:id/confirm', userAuth, (req, res) => {
  try {
    const result = vaccineStorage.confirmAlert(parseInt(req.params.id), req.body.note || '');
    if (result) {
      vaccineStorage.addOperationLog({
        user: req._auth.username, action: 'confirm_alert', target: `alert#${req.params.id}`,
        detail: `确认报警`, ip: req.ip
      });
      res.json({ success: true, message: '报警已确认' });
    } else {
      res.status(404).json({ success: false, error: '报警记录不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alerts/confirm-all', userAuth, (req, res) => {
  try {
    vaccineStorage.confirmAllAlerts();
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'confirm_all_alerts', target: 'alerts',
      detail: '确认全部报警', ip: req.ip
    });
    res.json({ success: true, message: '所有报警已确认' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 清理已确认的报警记录（必须先全部确认）
app.delete('/api/alerts/clear', adminAuth, (req, res) => {
  try {
    const result = vaccineStorage.clearConfirmedAlerts();
    if (result.success) {
      vaccineStorage.addOperationLog({
        user: req._auth.username, action: 'clear_alerts', target: 'alerts',
        detail: `清理 ${result.clearedCount} 条报警`, ip: req.ip
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================== 写操作 API（管理员） ========================

app.post('/api/vaccine/info', adminAuth, (req, res) => {
  try {
    const { key, info } = req.body;
    if (!key) return res.status(400).json({ success: false, error: '缺少key' });
    vaccineStorage.setVaccineInfo(key, info);
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'update_vaccine', target: key,
      detail: `更新疫苗信息: ${info.name || key}`, ip: req.ip
    });
    res.json({ success: true, message: '疫苗信息已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/temperature/tags', (req, res) => {
  try {
    const enabledOnly = req.query.enabled === 'true';
    const tags = enabledOnly ? vaccineStorage.getEnabledTags() : vaccineStorage.getAllTags();
    // 合并 vaccine_info 中的 temp_min/temp_max 到标签数据
    const vaccineInfo = vaccineStorage.getAllVaccineInfo();
    const mergeInfo = (tagList) => {
      for (const t of (Array.isArray(tagList) ? tagList : Object.values(tagList))) {
        const info = vaccineInfo[t.key] || {};
        if (info.temp_min && !t.temp_min) t.temp_min = info.temp_min;
        if (info.temp_max && !t.temp_max) t.temp_max = info.temp_max;
        if (info.name && !t.label) t.label = info.name;
        if (info.manufacturer && !t.manufacturer) t.manufacturer = info.manufacturer;
        if (info.batch && !t.batch) t.batch = info.batch;
        if (info.location && !t.location) t.location = info.location;
      }
      return tagList;
    };
    res.json({ success: true, data: mergeInfo(tags) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 批量更新所有标签温度阈值
app.post('/api/temperature/thresholds', adminAuth, (req, res) => {
  try {
    const { temp_min, temp_max } = req.body;
    const allTags = vaccineStorage.getAllTags();
    const allVaccine = vaccineStorage.getAllVaccineInfo();
    let count = 0;
    for (const key of Object.keys(allTags)) {
      // 1. 更新 temperature_tags 表（阈值主存储）
      vaccineStorage.upsertTag(key, {
        temp_min: temp_min != null ? String(temp_min) : '',
        temp_max: temp_max != null ? String(temp_max) : ''
      });
      // 2. 同步更新 vaccine_info 表（保持兼容）
      const existingInfo = allVaccine[key] || {};
      vaccineStorage.setVaccineInfo(key, {
        ...existingInfo,
        temp_min: temp_min != null ? temp_min : '',
        temp_max: temp_max != null ? temp_max : ''
      });
      count++;
    }
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'update_thresholds', target: 'all',
      detail: `批量更新报警阈值: ${temp_min}°C ~ ${temp_max}°C`, ip: req.ip
    });
    res.json({ success: true, message: `已更新 ${count} 个标签的温度阈值`, count });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/temperature/tags', adminAuth, (req, res) => {
  try {
    const { key, label, enabled, order, manufacturer, batch, expiry_start, expiry_end, location, temp_min, temp_max } = req.body;
    if (!key) return res.status(400).json({ success: false, error: '缺少key' });
    const tag = vaccineStorage.upsertTag(key, { key, label, enabled, order, temp_min: temp_min || '', temp_max: temp_max || '' });
    // 同步保存疫苗信息
    vaccineStorage.setVaccineInfo(key, {
      name: label || '',
      manufacturer: manufacturer || '',
      batch: batch || '',
      expiry_start: expiry_start || '',
      expiry_end: expiry_end || '',
      location: location || '',
      temp_min: temp_min || '',
      temp_max: temp_max || ''
    });
    vaccineStorage.addOperationLog({
      user: req._auth.username, action: 'upsert_tag', target: key,
      detail: `${tag ? '更新' : '新增'}温度标签: ${label || key}`, ip: req.ip
    });
    res.json({ success: true, data: tag, message: '标签已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/temperature/tags/:key', adminAuth, (req, res) => {
  try {
    const result = vaccineStorage.deleteTag(req.params.key);
    if (result) {
      vaccineStorage.addOperationLog({
        user: req._auth.username, action: 'delete_tag', target: req.params.key,
        detail: `删除温度标签: ${req.params.key}`, ip: req.ip
      });
      res.json({ success: true, message: '标签已删除' });
    } else {
      res.status(404).json({ success: false, error: '标签不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/statistics', (req, res) => {
  try {
    const type = req.query.type || 'daily';
    const limit = parseInt(req.query.limit) || 30;
    const stats = vaccineStorage.getStatistics(type, limit);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/status', (req, res) => {
  const totalCount = vaccineStorage.getDataCount(config.iotda.deviceId);
  res.json({
    success: true, status: 'running',
    deviceId: config.iotda.deviceId, totalRecords: totalCount,
    serverTime: new Date().toISOString()
  });
});

app.post('/api/device/command', adminAuth, async (req, res) => {
  try {
    const { device_id, command_name, paras } = req.body;
    const deviceId = device_id || config.iotda.deviceId;
    const token = await iotdaClient.getIAMToken();
    const url = `https://${iotdaClient.config.endpoint}/v5/iot/${config.iotda.projectId}/devices/${deviceId}/commands`;
    const response = await axios.post(url, {
      command_name: command_name || 'customCommand', paras: paras || {}
    }, { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } });
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});

// 前端静态文件路径（兼容本地和服务器部署）
const frontendPath = fs.existsSync(path.join(__dirname, 'frontend'))
  ? path.join(__dirname, 'frontend')
  : path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // HTML 不缓存（保证更新即时生效），其他静态资源缓存1小时
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
console.log('✓ 前端静态文件:', frontendPath);

// 兼容旧的 /api/admin/login 路由
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请输入账号和密码' });
  }
  const user = vaccineStorage.getUserByUsername(username);
  if (!user || user.password !== password) {
    return res.status(401).json({ success: false, error: '账号或密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(token, {
    userId: user.id, username: user.username, role: user.role,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  });
  vaccineStorage.addOperationLog({
    user: username, action: 'login', target: 'auth',
    detail: `用户登录(v1)`, ip: req.ip
  });
  res.json({ success: true, token, role: user.role });
});

const PORT = config.server.port;

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  疫苗温度监控系统 v2');
  console.log('========================================');
  console.log(`✓ Web服务器已启动: http://localhost:${PORT}`);
  console.log(`✓ API端点: http://localhost:${PORT}/api`);
  console.log('========================================\n');
});

process.on('SIGINT', () => { console.log('\n正在关闭...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n优雅关闭...'); process.exit(0); });
