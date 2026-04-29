const http = require('http');
const resources = [700102, 725331, 700509, 721070];
const locs = [1, 13, 56, 72];
(async () => {
  console.log('resourceId | locationId | retcode | datesCount | error');
  for (let rid of resources) {
    for (let lid of locs) {
      await new Promise(resolve => {
        const data = JSON.stringify({resourceId:rid, regionId:5, city:'Hyderabad', locationId:lid});
        const req = http.request({hostname:'localhost', port:3001, path:'/api/edoc/calendar-dates', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}}, (res) => {
          let b = ''; res.on('data', d => b += d);
          res.on('end', () => {
            let cnt = 0;
            if (res.statusCode === 200) {
              try { const j = JSON.parse(b); cnt = Array.isArray(j) ? j.length : (j.dates ? j.dates.length : 0); } catch(e) { cnt = 'N/A'; }
            }
            console.log(rid + ' | ' + lid + ' | ' + res.statusCode + ' | ' + cnt + ' | ' + (res.statusCode === 200 ? '' : b.substring(0,30)));
            resolve();
          });
        });
        req.on('error', e => { console.log(rid + ' | ' + lid + ' | Err | 0 | ' + e.message); resolve(); });
        req.write(data); req.end();
      });
    }
  }
})();