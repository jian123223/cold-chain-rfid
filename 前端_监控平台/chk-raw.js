const db = require('better-sqlite3')('./vaccine.db');

console.log('temperature_tags:');
const tags = db.prepare('SELECT * FROM temperature_tags').all();
tags.forEach(t => console.log(' ', t.key, 'enabled:', t.enabled, 'label:', t.label, 'min:', t.temp_min, 'max:', t.temp_max));

// 从最新一条 temperature_data 的 properties 中提取温度字段名
console.log('\nactual temperature fields from latest data:');
const td = db.prepare('SELECT properties FROM temperature_data WHERE properties IS NOT NULL AND properties != ? ORDER BY id DESC LIMIT 3').all('{}');
td.forEach(x => {
  const p = JSON.parse(x.properties);
  console.log(' ', Object.keys(p).join(', '));
});
