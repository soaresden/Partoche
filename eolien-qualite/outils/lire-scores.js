// Déchiffre un fichier de scores du jeu (joueur-….json, qualite2026-scores.json…) pour l'organisateur.
// Usage : node outils/lire-scores.js chemin/vers/fichier.json [index.html]
const fs = require('fs'), crypto = require('crypto');
const html = fs.readFileSync(process.argv[3] || __dirname + '/../index.html', 'utf8');
const cle = crypto.createHash('sha256').update(html.match(/const CLE_FICHIERS = '([^']+)'/)[1], 'utf8').digest();
const txt = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!txt.startsWith('QW26$')) { console.log(JSON.stringify(JSON.parse(txt), null, 1)); process.exit(0); }   // ancien format, en clair
const [, iv, ct] = txt.split('$'), brut = Buffer.from(ct, 'base64');
const d = crypto.createDecipheriv('aes-256-gcm', cle, Buffer.from(iv, 'base64'));
d.setAuthTag(brut.subarray(brut.length - 16));
console.log(JSON.stringify(JSON.parse(Buffer.concat([d.update(brut.subarray(0, brut.length - 16)), d.final()]).toString('utf8')), null, 1));
