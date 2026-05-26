const fs = require('fs');
const c = fs.readFileSync('client/dist/assets/index-S8-Yehx4.js', 'utf8');

// Find where Mg is called (not defined)
// The definition is "function Mg(" - skip that
// Look for "Mg(" preceded by anything that's not "function "
const re = /(?<!function\s)Mg\(/g;
let match;
let count = 0;
while ((match = re.exec(c)) !== null && count < 10) {
  const start = Math.max(0, match.index - 80);
  const end = Math.min(c.length, match.index + 120);
  console.log(`\n--- Call ${count} at ${match.index} ---`);
  console.log(c.substring(start, end));
  count++;
}
