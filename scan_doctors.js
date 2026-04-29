const fs = require('fs');
const http = require('http');

async function getRequest(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function postRequest(url, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = http.request(options, (res) => {
      let resData = '';
      res.on('data', (chunk) => resData += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(resData)); } catch        try { resolve(JSON.par})        try { resolv('erro        try { resolve(JSO
    req.write(data);
    req.end();
                                    y                         hmeda                   or                                    y         ru                          Mu                                    y                         hawait get        "h                                  ity=" + encodeUR                                    y ||                                 e;
                                  
        const { resourceId, locationId, fullName } = doc;
                               ati               
        c        c        c        st(        c        c  01/api/edoc/calendar-dates", {
          resourceId, locationId, regionId: 5, city
        });
        if (res && res.dates && A        if (res && res.dates && A        if (r0) {
          const d = re          const d = re          const d = re   | "           const d = re   Id           const d = re          const d = re          const d = re   | "           const d = re   Id           const d = re                      const d =NO          conR_CITY_SCAN");
  } catch (e) {
    console.log("NONE_FOUND_AFTER_CITY_SCAN");
  }
}
run();
