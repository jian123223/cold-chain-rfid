const db = require('better-sqlite3')('./vaccine.db');
db.pragma('wal_checkpoint(TRUNCATE)');
console.log('WAL checkpoint done');
const fs = require('fs');
const stat = fs.statSync('./vaccine.db');
console.log('DB size:', stat.size, 'bytes');
console.log('Date:', stat.mtime.toISOString());
// check if wal/shm files exist
console.log('wal exists:', fs.existsSync('./vaccine.db-wal'));
console.log('shm exists:', fs.existsSync('./vaccine.db-shm'));
