const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'vaccine.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temperature_data (
      id REAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      sensor_id TEXT,
      timestamp TEXT NOT NULL,
      lianwang INTEGER DEFAULT 1,
      zeren INTEGER,
      event_time TEXT,
      temperature REAL,
      temperature_1 REAL,
      temperature_2 REAL,
      temperature_3 REAL,
      raw_data TEXT,
      properties TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_temp_timestamp ON temperature_data(timestamp);
    CREATE INDEX IF NOT EXISTS idx_temp_device ON temperature_data(device_id);
    CREATE INDEX IF NOT EXISTS idx_temp_lianwang ON temperature_data(lianwang);
    CREATE INDEX IF NOT EXISTS idx_temp_zeren ON temperature_data(zeren);

    CREATE TABLE IF NOT EXISTS vaccine_info (
      sensor_id TEXT PRIMARY KEY,
      name TEXT,
      temperature REAL,
      humidity REAL,
      batch_number TEXT,
      manufacturer TEXT,
      temp_min TEXT,
      temp_max TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS temperature_tags (
      key TEXT PRIMARY KEY,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      order_num INTEGER DEFAULT 0,
      temp_min REAL,
      temp_max REAL,
      color TEXT,
      options TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_records (
      id INTEGER PRIMARY KEY,
      device_id TEXT,
      sensor_id TEXT,
      alert_type TEXT DEFAULT 'temperature',
      message TEXT,
      level TEXT,
      temperature REAL,
      threshold REAL,
      is_offline INTEGER DEFAULT 0,
      timestamp TEXT,
      created_at TEXT,
      confirmed INTEGER DEFAULT 0,
      confirmed_at TEXT,
      confirm_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alert_created ON alert_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_alert_confirmed ON alert_records(confirmed);
    CREATE INDEX IF NOT EXISTS idx_alert_type ON alert_records(alert_type);

    CREATE TABLE IF NOT EXISTS raw_logs (
      id INTEGER PRIMARY KEY,
      timestamp TEXT,
      body TEXT,
      ip TEXT,
      lianwang INTEGER,
      zeren INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_rawlog_timestamp ON raw_logs(timestamp);

    CREATE TABLE IF NOT EXISTS location_records (
      id INTEGER PRIMARY KEY,
      device_id TEXT,
      timestamp TEXT,
      latitude REAL,
      longitude REAL,
      dingwei_raw TEXT,
      address TEXT,
      raw_body TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_loc_device ON location_records(device_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      zeren INTEGER,
      duty TEXT DEFAULT '',
      responsibility TEXT DEFAULT '',
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY,
      timestamp TEXT,
      user TEXT,
      action TEXT,
      target TEXT,
      detail TEXT,
      ip TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_oplog_timestamp ON operation_logs(timestamp);

    CREATE TABLE IF NOT EXISTS statistics (
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER,
      max_temp REAL,
      min_temp REAL,
      avg_temp REAL,
      PRIMARY KEY (type, date)
    );
  `);

  // 兼容已有数据库的增量迁移
  try { db.exec('ALTER TABLE vaccine_info ADD COLUMN temp_min TEXT'); } catch (e) { /* 列已存在 */ }
  try { db.exec('ALTER TABLE vaccine_info ADD COLUMN temp_max TEXT'); } catch (e) { /* 列已存在 */ }
}

// 将 SQLite 行还原为完整的记录对象（合并 properties JSON）
function rowToRecord(row) {
  if (!row) return null;
  const record = { ...row };
  if (record.properties) {
    try {
      const props = JSON.parse(record.properties);
      Object.assign(record, props);
    } catch (e) { /* ignore */ }
  }
  if (record.raw_data && typeof record.raw_data === 'string') {
    try {
      record.raw_data = JSON.parse(record.raw_data);
    } catch (e) { /* keep as string */ }
  }
  // 清理内部字段
  delete record.properties;
  return record;
}

function rowsToRecords(rows) {
  return rows.map(rowToRecord);
}

// 从记录中提取已知字段和动态属性
function recordToRow(record) {
  const knownFields = ['id', 'device_id', 'sensor_id', 'timestamp', 'lianwang', 'zeren',
    'event_time', 'temperature', 'temperature_1', 'temperature_2', 'temperature_3', 'raw_data'];
  const row = {};
  const props = {};

  for (const [k, v] of Object.entries(record)) {
    if (knownFields.includes(k)) {
      row[k] = v;
    } else {
      props[k] = v;
    }
  }

  if (row.raw_data && typeof row.raw_data === 'object') {
    row.raw_data = JSON.stringify(row.raw_data);
  }

  row.properties = Object.keys(props).length > 0 ? JSON.stringify(props) : null;
  return row;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, initTables, rowToRecord, rowsToRecords, recordToRow, closeDb, DB_PATH };
