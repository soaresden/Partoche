// recopie le favori (codeFavori) dans l'écran de secours sans script de index.html
const fs = require('fs'), f = process.argv[2]; let s = fs.readFileSync(f, 'utf8');
const CONFIG = { sharepoint: { dossier: s.match(/dossier: '([^']+)'/)[1] } };
eval(s.match(/function codeFavori\(\) \{[\s\S]*?\n\}/)[0]);
const href = codeFavori().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
s = s.replace(/(id="favoriStatique" href=")[^"]*(")/, (m, a, b) => a + href + b);
fs.writeFileSync(f, s); console.log('favori statique :', href.length, 'caractères');
