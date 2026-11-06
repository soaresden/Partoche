// recopie le favori (codeFavori) et le lien du dossier (urlDossier) dans l'écran de secours sans script de index.html
const fs = require('fs'), f = process.argv[2]; let s = fs.readFileSync(f, 'utf8');
const lire = cle => (s.match(new RegExp(cle + ": '([^']*)'")) || [, ''])[1];
const CONFIG = { sharepoint: { origine: lire('origine'), lienDossier: lire('lienDossier'), dossier: lire('dossier') } };
const urlDossier = () => CONFIG.sharepoint.lienDossier;
eval(s.match(/function codeFavori\(\) \{[\s\S]*?\n\}/)[0]);
const html = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
s = s.replace(/(id="favoriStatique" href=")[^"]*(")/, (m, a, b) => a + html(codeFavori()) + b);
s = s.replace(/(id="dossierStatique" href=")[^"]*(")/, (m, a, b) => a + html(urlDossier()) + b);
fs.writeFileSync(f, s); console.log('favori statique :', codeFavori().length, 'caractères · dossier :', urlDossier());
