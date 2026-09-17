const { getDb, rowToRecord, rowsToRecords, recordToRow, initTables } = require('./database');

function initDB() {
  initTables();
}

// ======================== 温度数据 ========================

function insertTemperatureData(deviceId, sensorId, temperatures, rawData, lianwang, zeren, eventTime) {
  const db = getDb();

  let recordTimestamp = new Date().toISOString();
  if (eventTime && typeof eventTime === 'string') {
    try {
      const year = eventTime.substring(0, 4);
      const month = eventTime.substring(4, 6);
      const day = eventTime.substring(6, 8);
      const hour = eventTime.substring(9, 11);
      const minute = eventTime.substring(11, 13);
      const second = eventTime.substring(13, 15);
      recordTimestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`).toISOString();
    } catch (e) { /* use current time */ }
  }

  const record = {
    id: Date.now() + Math.random(),
    device_id: deviceId,
    sensor_id: sensorId || 'UNKNOWN',
    timestamp: recordTimestamp,
    lianwang: lianwang != null ? lianwang : 1,
    zeren: zeren || null,
    event_time: eventTime || null,
    raw_data: rawData,
    ...temperatures
  };

  const row = recordToRow(record);

  const stmt = db.prepare(`
    INSERT INTO temperature_data 
    (id, device_id, sensor_id, timestamp, lianwang, zeren, event_time, 
     temperature, temperature_1, temperature_2, temperature_3, raw_data, properties)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    row.id, row.device_id, row.sensor_id, row.timestamp,
    row.lianwang, row.zeren, row.event_time,
    row.temperature != null ? row.temperature : null,
    row.temperature_1 != null ? row.temperature_1 : null,
    row.temperature_2 != null ? row.temperature_2 : null,
    row.temperature_3 != null ? row.temperature_3 : null,
    row.raw_data || null,
    row.properties || null
  );

  return record.id;
}

function getLatestData(deviceId, limit = 20) {
  const db = getDb();
  let sql, rows;
  if (deviceId) {
    sql = 'SELECT * FROM temperature_data WHERE device_id = ? ORDER BY timestamp DESC LIMIT ?';
    rows = db.prepare(sql).all(deviceId, limit);
  } else {
    sql = 'SELECT * FROM temperature_data ORDER BY timestamp DESC LIMIT ?';
    rows = db.prepare(sql).all(limit);
  }
  return rowsToRecords(rows);
}

function getHistoricalData(deviceId, startTime, endTime, limit = 1000) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (deviceId) {
    conditions.push('device_id = ?');
    params.push(deviceId);
  }
  if (startTime) {
    conditions.push('timestamp >= ?');
    params.push(new Date(startTime).toISOString());
  }
  if (endTime) {
    conditions.push('timestamp <= ?');
    params.push(new Date(endTime).toISOString());
  }

  let sql = 'SELECT * FROM temperature_data';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY timestamp ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return rowsToRecords(rows);
}

function getDataStats(deviceId, startTime, endTime) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (deviceId) {
    conditions.push('device_id = ?');
    params.push(deviceId);
  }
  conditions.push('timestamp >= ?');
  params.push(startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  conditions.push('timestamp <= ?');
  params.push(endTime || new Date().toISOString());

  const sql = `
    SELECT 
      COUNT(*) as count,
      MAX(temperature) as max_temp, MIN(temperature) as min_temp, 
      AVG(temperature) as avg_temp,
      MAX(temperature_1) as max_temp_1, MIN(temperature_1) as min_temp_1, 
      AVG(temperature_1) as avg_temp_1,
      MAX(temperature_2) as max_temp_2, MIN(temperature_2) as min_temp_2, 
      AVG(temperature_2) as avg_temp_2,
      MAX(temperature_3) as max_temp_3, MIN(temperature_3) as min_temp_3, 
      AVG(temperature_3) as avg_temp_3
    FROM temperature_data
    WHERE ${conditions.join(' AND ')}
  `;

  const row = db.prepare(sql).get(...params);
  return row || {
    count: 0, max_temp: null, min_temp: null, avg_temp: null,
    max_temp_1: null, min_temp_1: null, avg_temp_1: null,
    max_temp_2: null, min_temp_2: null, avg_temp_2: null,
    max_temp_3: null, min_temp_3: null, avg_temp_3: null
  };
}

function getDataCount(deviceId) {
  const db = getDb();
  if (deviceId) {
    return db.prepare('SELECT COUNT(*) as c FROM temperature_data WHERE device_id = ?').get(deviceId).c;
  }
  return db.prepare('SELECT COUNT(*) as c FROM temperature_data').get().c;
}

// ======================== 疫苗信息 ========================

function setVaccineInfo(sensorId, info) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO vaccine_info (sensor_id, name, temperature, humidity, batch_number, manufacturer, temp_min, temp_max, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    sensorId,
    info.name || null,
    info.temperature != null ? info.temperature : null,
    info.humidity != null ? info.humidity : null,
    info.batch_number || null,
    info.manufacturer || null,
    info.temp_min != null ? info.temp_min : null,
    info.temp_max != null ? info.temp_max : null,
    new Date().toISOString()
  );
}

function getVaccineInfo(sensorId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM vaccine_info WHERE sensor_id = ?').get(sensorId);
  return row || null;
}

function getAllVaccineInfo() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM vaccine_info').all();
  const result = {};
  for (const row of rows) {
    result[row.sensor_id] = row;
  }
  return result;
}

// ======================== 报警管理 ========================

function addAlertRecord(alert) {
  const db = getDb();
  const id = Date.now() + Math.floor(Math.random() * 10000);
  const stmt = db.prepare(`
    INSERT INTO alert_records 
    (id, device_id, sensor_id, alert_type, message, level, temperature, threshold, 
     is_offline, timestamp, created_at, confirmed, confirmed_at, confirm_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
  `);
  stmt.run(
    id,
    alert.device_id || null,
    alert.sensor_id || null,
    alert.alert_type || 'temperature',
    alert.message || null,
    alert.level || null,
    alert.temperature != null ? alert.temperature : null,
    alert.threshold != null ? alert.threshold : null,
    alert.is_offline ? 1 : 0,
    alert.timestamp || new Date().toISOString(),
    new Date().toISOString()
  );
  return id;
}

function getAlertRecords(startTime, endTime, confirmed, alertType) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (startTime) {
    conditions.push('created_at >= ?');
    params.push(new Date(startTime).toISOString());
  }
  if (endTime) {
    conditions.push('created_at <= ?');
    params.push(new Date(endTime).toISOString());
  }
  if (confirmed !== undefined) {
    conditions.push('confirmed = ?');
    params.push(confirmed ? 1 : 0);
  }
  if (alertType) {
    conditions.push('alert_type = ?');
    params.push(alertType);
  }

  let sql = 'SELECT * FROM alert_records';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC';

  return db.prepare(sql).all(...params);
}

function getUnconfirmedAlertCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as c FROM alert_records WHERE confirmed = 0').get().c;
}

function clearConfirmedAlerts() {
  const db = getDb();
  const unconfirmedCount = db.prepare('SELECT COUNT(*) as c FROM alert_records WHERE confirmed = 0').get().c;
  if (unconfirmedCount > 0) {
    return { success: false, unconfirmedCount, message: `还有 ${unconfirmedCount} 条报警未确认，请先确认所有报警后再清理` };
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM alert_records').get().c;
  db.prepare('DELETE FROM alert_records').run();
  return { success: true, clearedCount: count, message: `已清理 ${count} 条报警记录` };
}

function confirmAlert(alertId, note = '') {
  const db = getDb();
  const result = db.prepare(`
    UPDATE alert_records SET confirmed = 1, confirmed_at = ?, confirm_note = ? WHERE id = ?
  `).run(new Date().toISOString(), note, alertId);
  return result.changes > 0;
}

function confirmAllAlerts() {
  const db = getDb();
  db.prepare(`
    UPDATE alert_records SET confirmed = 1, confirmed_at = ? WHERE confirmed = 0
  `).run(new Date().toISOString());
}

// ======================== 原始日志 ========================

function addRawLog(data) {
  const db = getDb();
  const id = Date.now();
  db.prepare(`
    INSERT INTO raw_logs (id, timestamp, body, ip, lianwang, zeren)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    data ? JSON.stringify(data) : null,
    data && data._ip ? data._ip : null,
    data && data._lianwang != null ? data._lianwang : null,
    data && data._zeren != null ? data._zeren : null
  );
  // 保留最近 5000 条
  db.prepare(`
    DELETE FROM raw_logs WHERE id NOT IN (SELECT id FROM raw_logs ORDER BY id DESC LIMIT 5000)
  `).run();
  return id;
}

function getRawLogs(page = 1, pageSize = 50, startTime, endTime, lianwang) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (startTime) {
    conditions.push('timestamp >= ?');
    params.push(new Date(startTime).toISOString());
  }
  if (endTime) {
    conditions.push('timestamp <= ?');
    params.push(new Date(endTime).toISOString());
  }
  if (lianwang !== undefined && lianwang !== null && lianwang !== '') {
    conditions.push('lianwang = ?');
    params.push(parseInt(lianwang));
  }

  let whereClause = '';
  if (conditions.length > 0) {
    whereClause = ' WHERE ' + conditions.join(' AND ');
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM raw_logs${whereClause}`).get(...params).c;
  const offset = (page - 1) * pageSize;
  const data = db.prepare(`SELECT * FROM raw_logs${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);

  // Parse body JSON
  return {
    data: data.map(row => {
      try { return { ...row, body: JSON.parse(row.body) }; } catch (e) { return row; }
    }),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}

function clearRawLogs() {
  const db = getDb();
  db.prepare('DELETE FROM raw_logs').run();
}

// ======================== 位置记录 ========================

function addLocationRecord(deviceId, dingwei, address, rawBody) {
  const db = getDb();
  const coords = dingwei.split(',');
  const id = Date.now();
  db.prepare(`
    INSERT INTO location_records (id, device_id, timestamp, latitude, longitude, dingwei_raw, address, raw_body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    deviceId,
    new Date().toISOString(),
    parseFloat(coords[1]),
    parseFloat(coords[0]),
    dingwei,
    address || '',
    rawBody ? JSON.stringify(rawBody) : null
  );
  // 保留最近 500 条
  db.prepare(`
    DELETE FROM location_records WHERE id NOT IN (SELECT id FROM location_records ORDER BY id DESC LIMIT 500)
  `).run();
  return { id, device_id: deviceId, latitude: parseFloat(coords[1]), longitude: parseFloat(coords[0]), dingwei_raw: dingwei, address };
}

function getLatestLocation(deviceId) {
  const db = getDb();
  let row;
  if (deviceId) {
    row = db.prepare('SELECT * FROM location_records WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(deviceId);
  } else {
    row = db.prepare('SELECT * FROM location_records ORDER BY id DESC LIMIT 1').get();
  }
  if (row && row.raw_body) {
    try { row.raw_body = JSON.parse(row.raw_body); } catch (e) { /* keep as string */ }
  }
  return row || null;
}

function getLocationHistory(deviceId, limit = 100) {
  const db = getDb();
  let rows;
  if (deviceId) {
    rows = db.prepare('SELECT * FROM location_records WHERE device_id = ? ORDER BY id DESC LIMIT ?').all(deviceId, limit);
  } else {
    rows = db.prepare('SELECT * FROM location_records ORDER BY id DESC LIMIT ?').all(limit);
  }
  return rows;
}

// hasDingwei - 深度搜索对象中是否包含 dingwei 字段
function hasDingwei(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.dingwei !== undefined) return true;
  if (obj.properties && obj.properties.dingwei !== undefined) return true;
  if (Array.isArray(obj.services)) {
    for (const svc of obj.services) {
      if (svc.properties && svc.properties.dingwei !== undefined) return true;
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (hasDingwei(item)) return true;
    }
  }
  if (obj.notify_data) return hasDingwei(obj.notify_data);
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null && k !== 'body') {
      if (hasDingwei(v)) return true;
    }
  }
  return false;
}

function getLocationLogs(page = 1, pageSize = 50, startTime, endTime) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (startTime) {
    conditions.push('timestamp >= ?');
    params.push(new Date(startTime).toISOString());
  }
  if (endTime) {
    conditions.push('timestamp <= ?');
    params.push(new Date(endTime).toISOString());
  }

  let whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

  // 需要全量查出再在 JS 中过滤 hasDingwei
  const allRows = db.prepare(`SELECT * FROM raw_logs${whereClause} ORDER BY id DESC`).all(...params);

  const filtered = allRows.filter(log => {
    try {
      const body = typeof log.body === 'string' ? JSON.parse(log.body) : log.body;
      return body && hasDingwei(body);
    } catch (e) { return false; }
  });

  const start = (page - 1) * pageSize;
  const data = filtered.slice(start, start + pageSize).map(row => {
    try { return { ...row, body: JSON.parse(row.body) }; } catch (e) { return row; }
  });

  return {
    data,
    total: filtered.length,
    page,
    pageSize,
    totalPages: Math.ceil(filtered.length / pageSize)
  };
}

// ======================== 用户管理 ========================

function ensureUsers() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count === 0) {
    const stmt = db.prepare(`
      INSERT INTO users (id, username, password, role, zeren, duty, responsibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    stmt.run(1, 'admin', 'admin123', 'super_admin', 0, '超级管理员', '系统管理', now);
    stmt.run(2, 'admin1', 'admin123', 'admin', 1, '冷链主管', '', now);
    stmt.run(3, 'admin2', 'admin123', 'admin', 2, '质量监督', '', now);
    stmt.run(4, 'admin3', 'admin123', 'admin', 3, '仓储管理', '', now);
    stmt.run(5, 'admin4', 'admin123', 'admin', 4, '运输监控', '', now);
  }
}

function getUserByUsername(username) {
  ensureUsers();
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getUserById(id) {
  ensureUsers();
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByZeren(zeren) {
  ensureUsers();
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE zeren = ? AND role = ?').get(zeren, 'admin') || null;
}

function getFullUserByUsername(username) {
  ensureUsers();
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getAllUsers() {
  ensureUsers();
  const db = getDb();
  return db.prepare('SELECT id, username, role, zeren, duty, responsibility, created_at FROM users ORDER BY id').all();
}

function createUser(username, password, role, extra) {
  ensureUsers();
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return null;

  const maxId = db.prepare('SELECT MAX(id) as m FROM users').get().m || 0;
  const id = maxId + 1;

  db.prepare(`
    INSERT INTO users (id, username, password, role, zeren, duty, responsibility, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, username, password, role || 'user',
    (extra && extra.zeren) || null,
    (extra && extra.duty) || '',
    (extra && extra.responsibility) || '',
    new Date().toISOString()
  );

  return { id, username, role: role || 'user', zeren: (extra && extra.zeren) || null, duty: (extra && extra.duty) || '', responsibility: (extra && extra.responsibility) || '' };
}

function updateUser(id, updates) {
  ensureUsers();
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;

  const sets = [];
  const params = [];

  if (updates.password !== undefined) { sets.push('password = ?'); params.push(updates.password); }
  if (updates.role !== undefined) { sets.push('role = ?'); params.push(updates.role); }
  if (updates.zeren !== undefined) { sets.push('zeren = ?'); params.push(updates.zeren); }
  if (updates.duty !== undefined) { sets.push('duty = ?'); params.push(updates.duty || ''); }
  if (updates.responsibility !== undefined) { sets.push('responsibility = ?'); params.push(updates.responsibility || ''); }

  if (sets.length > 0) {
    params.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { id: updated.id, username: updated.username, role: updated.role, zeren: updated.zeren, duty: updated.duty || '', responsibility: updated.responsibility || '' };
}

function deleteUser(id) {
  ensureUsers();
  const db = getDb();
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

// ======================== 操作日志 ========================

function addOperationLog(data) {
  const db = getDb();
  const id = Date.now();
  db.prepare(`
    INSERT INTO operation_logs (id, timestamp, user, action, target, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    data.user || 'unknown',
    data.action,
    data.target || null,
    data.detail || '',
    data.ip || null
  );
  // 保留最近 10000 条
  db.prepare(`
    DELETE FROM operation_logs WHERE id NOT IN (SELECT id FROM operation_logs ORDER BY id DESC LIMIT 10000)
  `).run();
  return id;
}

function getOperationLogs(page, pageSize, startTime, endTime, action, user) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (startTime) {
    conditions.push('timestamp >= ?');
    params.push(new Date(startTime).toISOString());
  }
  if (endTime) {
    conditions.push('timestamp <= ?');
    params.push(new Date(endTime).toISOString());
  }
  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (user) {
    conditions.push('user = ?');
    params.push(user);
  }

  let whereClause = '';
  if (conditions.length > 0) {
    whereClause = ' WHERE ' + conditions.join(' AND ');
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM operation_logs${whereClause}`).get(...params).c;
  const offset = (page - 1) * pageSize;
  const data = db.prepare(`SELECT * FROM operation_logs${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);

  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

// ======================== 统计数据 ========================

function calculateStatistics() {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const stats = db.prepare(`
    SELECT 
      COUNT(*) as count,
      MAX(temperature) as max_temp,
      MIN(temperature) as min_temp,
      AVG(temperature) as avg_temp
    FROM temperature_data
    WHERE timestamp >= ? AND timestamp < ?
  `).get(today + 'T00:00:00.000Z', today + 'T23:59:59.999Z');

  if (stats && stats.count > 0) {
    db.prepare(`
      INSERT OR REPLACE INTO statistics (type, date, count, max_temp, min_temp, avg_temp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('daily', today, stats.count, stats.max_temp, stats.min_temp, stats.avg_temp);
  }

  return db.prepare('SELECT * FROM statistics WHERE type = ? ORDER BY date DESC').all('daily');
}

function getStatistics(type = 'daily', limit = 30) {
  const db = getDb();
  return db.prepare('SELECT * FROM statistics WHERE type = ? ORDER BY date DESC LIMIT ?').all(type, limit);
}

// ======================== 温度标签管理 ========================

function getAllTags() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM temperature_tags').get().c;
  if (count === 0) {
    // 初始化默认标签
    const stmt = db.prepare('INSERT INTO temperature_tags (key, label, enabled, order_num) VALUES (?, ?, 1, ?)');
    stmt.run('2025022100000116', '传感器 1', 0);
    stmt.run('2025022100000117', '传感器 2', 1);
    stmt.run('2025022100000118', '传感器 3', 2);
  }

  const rows = db.prepare('SELECT * FROM temperature_tags ORDER BY order_num').all();
  const result = {};
  for (const row of rows) {
    let options = {};
    if (row.options) {
      try { options = JSON.parse(row.options); } catch (e) { /* ignore */ }
    }
    result[row.key] = {
      key: row.key,
      label: row.label,
      enabled: row.enabled !== 0,
      order: row.order_num,
      temp_min: row.temp_min,
      temp_max: row.temp_max,
      color: row.color,
      ...options
    };
  }
  return result;
}

function getEnabledTags() {
  const tags = getAllTags();
  return Object.values(tags)
    .filter(t => t.enabled !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function upsertTag(key, tagData) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM temperature_tags WHERE key = ?').get(key);

  let options = {};
  if (existing && existing.options) {
    try { options = JSON.parse(existing.options); } catch (e) { /* ignore */ }
  }
  // 提取非标准字段到 options
  const standardFields = ['key', 'label', 'enabled', 'order_num', 'temp_min', 'temp_max', 'color', 'options'];
  for (const [k, v] of Object.entries(tagData)) {
    if (!standardFields.includes(k) && k !== 'order') {
      options[k] = v;
    }
  }

  if (existing) {
    const sets = [];
    const params = [];
    if (tagData.label !== undefined) { sets.push('label = ?'); params.push(tagData.label); }
    if (tagData.enabled !== undefined) { sets.push('enabled = ?'); params.push(tagData.enabled ? 1 : 0); }
    if (tagData.order !== undefined) { sets.push('order_num = ?'); params.push(tagData.order); }
    if (tagData.temp_min !== undefined) { sets.push('temp_min = ?'); params.push(tagData.temp_min); }
    if (tagData.temp_max !== undefined) { sets.push('temp_max = ?'); params.push(tagData.temp_max); }
    if (tagData.color !== undefined) { sets.push('color = ?'); params.push(tagData.color); }
    sets.push('options = ?');
    params.push(Object.keys(options).length > 0 ? JSON.stringify(options) : null);
    params.push(key);
    db.prepare(`UPDATE temperature_tags SET ${sets.join(', ')} WHERE key = ?`).run(...params);
  } else {
    const maxOrder = (db.prepare('SELECT MAX(order_num) as m FROM temperature_tags').get().m || 0) + 1;
    db.prepare(`
      INSERT INTO temperature_tags (key, label, enabled, order_num, temp_min, temp_max, color, options)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      tagData.label || key,
      tagData.enabled !== false ? 1 : 0,
      tagData.order || maxOrder,
      tagData.temp_min || null,
      tagData.temp_max || null,
      tagData.color || null,
      Object.keys(options).length > 0 ? JSON.stringify(options) : null
    );
  }

  const row = db.prepare('SELECT * FROM temperature_tags WHERE key = ?').get(key);
  let opts = {};
  if (row.options) { try { opts = JSON.parse(row.options); } catch (e) { /* ignore */ } }
  return { key: row.key, label: row.label, enabled: row.enabled !== 0, order: row.order_num, temp_min: row.temp_min, temp_max: row.temp_max, color: row.color, ...opts };
}

function deleteTag(key) {
  const db = getDb();
  const result = db.prepare('DELETE FROM temperature_tags WHERE key = ?').run(key);
  return result.changes > 0;
}

module.exports = {
  getAllTags,
  getEnabledTags,
  upsertTag,
  deleteTag,
  initDB,
  insertTemperatureData,
  getLatestData,
  getHistoricalData,
  getDataStats,
  getDataCount,
  setVaccineInfo,
  getVaccineInfo,
  getAllVaccineInfo,
  addAlertRecord,
  getAlertRecords,
  getUnconfirmedAlertCount,
  clearConfirmedAlerts,
  confirmAlert,
  confirmAllAlerts,
  addRawLog,
  getRawLogs,
  clearRawLogs,
  addLocationRecord,
  getLatestLocation,
  getLocationHistory,
  getLocationLogs,
  calculateStatistics,
  getStatistics,
  getUserByUsername,
  getUserById,
  getUserByZeren,
  getFullUserByUsername,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  addOperationLog,
  getOperationLogs
};
