const fs = require('fs');
const http = require('http');

async function testDoctors() {
  const content = fs.readFileSync('doctors_to_test.txt', 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const p = line.split(/[ \t]+/);
    const resId = p[0].trim(), locId = p[1].trim();
    const res = await new Promise(resolve => {
      const body = JSON.stringify({resourceId: resId, locationId: locId, regionId: 5});
      const req = http.request({
        hostname: 'localhost', port: 3001, path: '/api/edoc/calendar-dates',
        method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}
      }, r => {
        let b = ''; r.on('data', d => b += d);
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
      });
      req.on('error', () => resolve({}));
      req.write(body); req.end();
    });
    if (res && res.dates && res.dates.length > 0) {
                                       sole.log(resId + ", " +                          lengt                              " + d.edocDate);
      return;
    }
  }
  console.log("NONE_FOUND");
}
testDoctors();
