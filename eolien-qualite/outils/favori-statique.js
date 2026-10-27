// recopie le favori (codeFavori) et l'adresse du dossier (urlDossier) dans l'écran de secours sans script de index.html
const fs = require('fs'), f = process.argv[2]; let s = fs.readFileSync(f, 'utf8');
const CONFIG = { sharepoint: { origine: s.match(/origine: '([^']+)'/)[1], dossier: s.match(/dossier: '([^']+)'/)[1] } };
eval(s.match(/const urlDossier = [^\n]+/)[0].replace('const urlDossier', 'globalThis.urlDossier'));
eval(s.match(/function codeFavori\(\) \{[\s\S]*?\n\}/)[0]);
const html = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
s = s.replace(/(id="favoriStatique" href=")[^"]*(")/, (m, a, b) => a + html(codeFavori()) + b);
s = s.replace(/(id="dossierStatique" href=")[^"]*(")/, (m, a, b) => a + html(urlDossier()) + b);
fs.writeFileSync(f, s); console.log('favori statique :', codeFavori().length, 'caractères · dossier :', urlDossier());
