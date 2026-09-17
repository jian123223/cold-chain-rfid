const Database = require('better-sqlite3');
const db = new Database('vaccine.db', { readonly: true });
const cnt = db.prepare('SELECT COUNT(*) as c FROM temperature_data').get();
console.log('temperature_data count:', cnt.c);
const last = db.prepare('SELECT id, timestamp, properties FROM temperature_data ORDER BY timestamp DESC LIMIT 2').all();
console.log('Last 2:', JSON.stringify(last, null, 2));
const integrity = db.pragma('integrity_check');
console.log('Integrity:', integrity[0].integrity_check);
db.close();
