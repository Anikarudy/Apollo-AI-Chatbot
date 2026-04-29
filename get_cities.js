const fs = require('fs');
const content = fs.readFileSync('src/generatedData.ts', 'utf8');
const startMatch = content.indexOf('export const hospitalsByCity');
if (startMatch !== -1) {
    const fromStart = content.substring(startMatch);
    const endMatch = fromStart.indexOf('};');
    const objectContent = fromStart.substring(0, endMatch + 2);
    const cityMatches = objectContent.matchAll(/^  "([^"]+)"\s*:/gm);
    const cities = [...new Set(Array.from(cityMatches).map(m => m[1]))];
    console.log(JSON.stringify(cities));
} else {
    console.log('[]');
}
