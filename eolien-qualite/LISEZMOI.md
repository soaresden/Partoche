# Gardez le parc en mouvement — Semaine de la qualité 2026

Jeu HTML en un seul fichier, en français et en anglais, pour la Semaine mondiale de la qualité, du 9 au 13 novembre 2026,
sur le thème « Quality: Powering Performance ». Il reprend la vraie implantation du parc éolien en mer du Calvados :
64 éoliennes, 13 strings, l'OSS et les distances réelles.

Le jeu fonctionne de deux façons, avec le même fichier `index.html` :

- **Lien partagé + favori** : chacun joue depuis son PC, identifié par son compte EDF.
- **Stand** : le jeu tourne sur un PC, ouvert en local.

## 1. Lien partagé + favori (chacun sur son PC)

**Pourquoi un favori ?** Ouvert depuis un lien OneDrive ou SharePoint, un `.html` s'affiche dans un *aperçu isolé*
qui n'a le droit ni d'écrire ni de parler à SharePoint. Le favori charge le jeu **à l'intérieur de la vraie page
SharePoint**, avec le compte de la personne : le jeu sait qui joue et peut enregistrer son score.

**Mise en place (organisateur)**
1. `index.html` est dans le dossier OneDrive `QualityWeek2026`. Son chemin est réglé dans `CONFIG.sharepoint.dossier` :
   mettez-le à jour si vous déplacez le dossier.
2. Créez dans ce dossier un sous-dossier **`donnees`**. Le premier joueur le crée sinon, s'il en a le droit.
3. Partagez **`QualityWeek2026` en lecture** et **`donnees` en modification** avec les participants
   (par exemple « Personnes d'EDF disposant du lien »).
4. Partagez le lien vers `index.html`. Si vous le partagez par **Teams**, précisez de l'ouvrir dans **Edge** (« … » › Ouvrir dans le navigateur) :
   Teams n'a pas de barre de favoris. L'écran d'accueil du lien le rappelle, en français et en anglais (bouton FR / EN).

**Pour jouer (participants)**
1. Ouvrir le lien partagé : l'aperçu affiche un **mode d'emploi** avec un gros bouton jaune « ⬆ Glissez-moi dans la barre des favoris ».
2. **Glisser ce bouton dans la barre des favoris** d'Edge (Ctrl+Maj+B pour l'afficher). Si le glisser ne marche pas,
   le mode d'emploi donne le code à coller dans un favori.
3. Ouvrir le dossier `QualityWeek2026` dans le navigateur, puis **cliquer sur le favori** : le jeu se lance,
   le nom est déjà rempli et les scores s'enregistrent.

**Sécurité de SharePoint.** SharePoint n'exécute que les scripts qui portent son jeton de sécurité. Le favori reprend ce jeton,
et sinon lance le jeu autrement. Si le jeu ne démarre pas, le favori affiche la raison exacte : envoyez-la, avec une capture de la console (F12).
Les polices Google sont bloquées par SharePoint : le jeu utilise alors les polices du système, sans gêne.
Quand le code du favori change (nouvelle version), il faut **refaire le glisser** du bouton jaune.
Si SharePoint bloque le jeu (ancien favori, ou simple aperçu), la page affiche d'elle-même un écran « Pour jouer, installez le favori ⭐ »
avec le bon bouton à glisser. Ce bouton est recopié dans `index.html` par `node outils/favori-statique.js index.html` :
relancez cette commande si vous changez `CONFIG.sharepoint.dossier`.

**Données et anti-triche**
- Chaque joueur écrit **uniquement son fichier** : `donnees/joueur-<adresse e-mail>.json` (ses parties, sa carrière, son temps de jeu).
- Chaque fichier est **signé**. Un fichier modifié à la main ne passe plus le contrôle : ses scores sont écartés des classements
  et apparaissent grisés avec ⚠ dans le panneau organisateur. Les scores impossibles (trop élevés, partie trop courte) sont écartés aussi.
- SharePoint garde l'historique des versions et l'auteur de chaque modification.
- Limite honnête : un développeur déterminé pourrait recalculer une signature. Pour un jeu interne, c'est largement suffisant.

## 2. Stand (le jeu tourne sur un PC)

Le jeu écrit des fichiers JSON à côté de lui, dans le dossier OneDrive synchronisé. Seul ce PC écrit dans ces fichiers :
les joueurs ne peuvent pas les modifier.

| Fichier | Rôle |
| --- | --- |
| `qualite2026-scores.json` | créé par le jeu : toutes les parties (nom, mode, score, temps de jeu…) |
| `qualite2026-carrieres.json` | créé par le jeu : les carrières, une par nom de joueur |

**Mise en route**

1. Placez `index.html` dans le dossier OneDrive synchronisé (par exemple `QualityWeek2026`).
2. Ouvrez-le avec **Edge** (ou Chrome) **depuis l'Explorateur Windows** : clic droit › Ouvrir avec › Microsoft Edge.
   Ne passez pas par l'aperçu du site OneDrive ou SharePoint : il interdit l'écriture de fichiers, et le jeu affiche alors un avertissement.
3. Ouvrez le panneau organisateur (5 clics sur le logo), cliquez sur **« 📁 Choisir le dossier des scores »**, sélectionnez ce même dossier,
   puis acceptez l'autorisation de modification. Les joueurs, eux, n'ont jamais de dossier à choisir.
4. Aux lancements suivants, le jeu retrouve le dossier tout seul. Edge peut redemander l'autorisation : dans le panneau organisateur,
   le bouton devient **« 🔌 Autoriser le dossier »**, un clic suffit. Si le poste interdit au navigateur de mémoriser le dossier, rechoisissez-le à chaque lancement.

- Tant que le dossier n'est pas relié, les scores sont gardés dans le navigateur. Ils sont versés dans les fichiers dès que le dossier est relié.
- OneDrive conserve l'historique des versions des fichiers : en cas d'erreur, on peut revenir en arrière.
- Firefox ne sait pas écrire de fichiers : utilisez Edge ou Chrome.

## Les deux façons de jouer

- **⚡ Sprint 90 s, pour tout le monde.** Une journée (6 h → 22 h) en 90 secondes. Avant de jouer, une carte présente les règles en 20 secondes,
  puis un petit dessin animé (11 s, on peut le passer) montre le CTV qui se prépare à Ouistreham et appareille.
  On clique sur une éolienne orange et on choisit **Réparer** (rapide) ou **Fiabiliser** (plus long, mais le défaut ne revient presque plus : l'éolienne devient dorée).
  Au 1er défaut, on répare et on observe : la fiabilisation n'est possible qu'**à partir du 2ᵉ défaut** (la cause est alors confirmée).
  À ce moment, le jeu se met en pause une fois : « C'est la 2ᵉ fois que cette éolienne a un problème : il serait temps de la fiabiliser, tu ne penses pas ? »
  On n'a que **5 kits de fiabilisation** : impossible de tout fiabiliser, il faut garder les kits pour celles qui reviennent le plus (Pareto).
  Chaque défaut coûte **50 points** (coût de la non-qualité), détaillé en fin de partie.
  Il n'y a pas de pièces, de carburant ni de météo à gérer. Tous les joueurs d'une même journée ont le même vent, pour un classement équitable.
  Réglage vérifié au bot : fiabiliser les récidivistes rapporte environ 10 % de points de plus que courir d'une panne à l'autre.
- **🧭 Carrière, pour ceux qui accrochent.** Des journées de 3 minutes, reprises avec son nom. Chaque soir, l'électricité vendue,
  moins les pièces, le carburant et les rotors remplacés, donne un budget pour améliorer le bateau à la base.
  Une mécanique s'ajoute chaque jour :
  - jour 1 : les pièces et la base ;
  - jour 2 : le **briefing du matin** (voir plus bas), le carburant, le brouillard et la houle ;
  - jour 3 : le dépôt de pièces de l'OSS et les dauphins ;
  - jour 4 : les grains (au-delà de 1,5 m de houle, transfert impossible) et le défaut du transformateur de l'OSS (−50 %) ;
  - jour 5 : les défauts de câble et les incendies.

**Le briefing du matin (Carrière, à partir du jour 2).** À 6 h, avant d'appareiller, la carte montre le journal d'hier
(badges « hier ×N » sur les éoliennes qui ont eu des défauts). On clique sur les éoliennes à fiabiliser, dans l'ordre de passage :
le trajet s'affiche en jaune, avec les kilomètres, le temps estimé et les pièces nécessaires. Puis on valide, et le bateau part sur ce plan.
Pendant la journée, la tournée restante reste tracée en pointillés.

**Les améliorations du bateau (Carrière)** : moteurs (vitesse), soute (pièces à bord), réservoir (carburant),
**techniciens à bord** (un technicien de plus par niveau, interventions plus courtes), radar météo, supervision SCADA,
et le **planificateur** : 8 puis 10 ordres dans la barre du bas, et le bouton « Optimiser le trajet » au briefing.

**Ce qu'on voit à l'écran**
- Le **vent** varie, avec des rafales et des accalmies, et la production suit la courbe de puissance des éoliennes : c'est une énergie intermittente.
- Une éolienne en défaut est d'abord **bridée à 40 %**. Négligée, elle passe en arrêt de sécurité, puis peut prendre feu et exploser.
  Si elle explose, toutes les éoliennes situées après elle sur le string sont coupées.
- Les **éoliennes fiabilisées sont dorées**. Des mouettes, des dauphins et un cargo animent la mer.
- En fin de partie, un vrai **diagramme de Pareto** : les défauts par éolienne, du plus fréquent au plus rare, la courbe cumulée et le seuil de 80 %.
  On y voit d'un coup d'œil que quelques éoliennes « plus exposées » font l'essentiel des défauts.
- Le bouton **📋 Compte rendu** ouvre la réunion de fin de journée : le chef d'équipe dit ce qui a été réparé et fiabilisé,
  la référente qualité interprète (« ça fait 3 fois qu'on la répare : il y a un vrai souci, il faut la fiabiliser au plus tôt demain »),
  la supervision donne le Pareto et le coût de la non-qualité, puis vient la décision et un plan d'actions pour demain.
  En Carrière, ces priorités apparaissent au briefing du lendemain (badge rouge « priorité »).
- L'écran de fin remercie le joueur et propose **Pile Poil**, l'autre jeu du projet.

**L'accueil** est en fête : guirlande, confettis, ballons « Q » à éclater d'un clic, feux d'artifice (plus nombreux le jeudi 12 novembre).
L'onglet **Animations** permet de revoir le dessin animé du CTV.

Le vocabulaire reste neutre vis-à-vis du constructeur : on parle de « défauts » et d'éoliennes « plus exposées » (houle, embruns),
jamais de matériel peu fiable. Pour retirer les incendies et les explosions, passez `incendies: false` dans `CONFIG`,
en haut du script : une éolienne négligée s'arrêtera alors simplement.

## Panneau organisateur

Sur l'accueil, **cliquez 5 fois rapidement sur le logo du parc** (en haut à gauche). Il n'y a pas de mot de passe.
On y trouve aussi le bouton **⭐ Favori à partager**, à glisser dans sa barre de favoris.

- **Parties** : date, nom, mode, score, temps de jeu. On peut corriger un nom ou un score, supprimer des lignes ou tout effacer.
- **Carrières** : jour atteint, énergie cumulée, budget, temps total. On peut supprimer des carrières.
- On peut aussi changer le dossier des scores et télécharger les deux fichiers JSON.

Toutes les modifications sont aussitôt écrites : dans les fichiers du dossier (stand) ou dans le fichier du joueur concerné (lien partagé).

## Réglages utiles (dans `index.html`, objet `CONFIG` et `PARAMS`)

- `dureeShift` : durée d'un shift (30 s en Sprint, 60 s en Carrière).
- `incendies` : `false` pour désactiver le feu et les explosions.
- `prixMWh`, `prixPiece`, `prixPlein`, `prixRemplacement`, `stockOSS` : l'économie de la Carrière.
- `PARAMS.risqueFragile` / `risqueNormal` : la fréquence des défauts. Actuellement, il y en a environ 15 à 25 par Sprint selon la façon de jouer.

L'équilibrage a été vérifié avec un bot qui joue des centaines de parties. Dans tous les modes,
fiabiliser les éoliennes qui reviennent souvent divise le nombre de défauts par deux environ par rapport à
« courir d'une panne à l'autre ». En Carrière, cela rapporte aussi nettement plus de budget.
