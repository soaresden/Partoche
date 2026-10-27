# Gardez le parc en mouvement — Semaine de la qualité 2026

Jeu HTML en un seul fichier, en français et en anglais, pour la Semaine mondiale de la qualité, du 9 au 13 novembre 2026,
sur le thème « Quality: Powering Performance ». Il reprend la vraie implantation du parc éolien en mer du Calvados :
64 éoliennes, 13 strings, l'OSS et les distances réelles.

**Principe : le jeu tourne sur le PC du stand.** Les scores sont écrits dans des fichiers JSON, à côté du jeu,
dans le dossier OneDrive synchronisé. Seul ce PC écrit dans ces fichiers : les joueurs ne peuvent pas les modifier.

| Fichier | Rôle |
| --- | --- |
| `index.html` | le jeu complet |
| `qualite2026-scores.json` | créé par le jeu : toutes les parties (nom, mode, score, temps de jeu…) |
| `qualite2026-carrieres.json` | créé par le jeu : les carrières, une par nom de joueur |

## Mise en route sur le PC du stand

1. Placez `index.html` dans le dossier OneDrive synchronisé (par exemple `QualityWeek2026`).
2. Ouvrez-le avec **Edge** (ou Chrome) : double-clic, ou glisser le fichier dans le navigateur.
3. Dans le cadre « Classements », cliquez sur **« Choisir le dossier des scores »**, sélectionnez ce même dossier,
   puis acceptez l'autorisation de modification. Le message devient « Scores enregistrés dans le dossier … ».
4. Aux lancements suivants, le jeu retrouve le dossier tout seul. Edge peut redemander l'autorisation :
   un seul clic sur « Autoriser ».

- Tant que le dossier n'est pas relié, les scores sont gardés dans le navigateur. Ils sont versés dans les fichiers dès que le dossier est relié.
- OneDrive conserve l'historique des versions des fichiers : en cas d'erreur, on peut revenir en arrière.
- Firefox ne sait pas écrire de fichiers : utilisez Edge ou Chrome.

## Les deux façons de jouer

- **⚡ Sprint 90 s, pour tout le monde.** Une journée (6 h → 22 h) en 90 secondes. Avant de jouer, une carte présente les règles en 20 secondes.
  On clique sur une éolienne orange et on choisit **Réparer** (rapide) ou **Fiabiliser** (plus long, mais le défaut ne revient presque plus : l'éolienne devient dorée).
  Il n'y a pas de pièces, de carburant ni de météo à gérer. Tous les joueurs d'une même journée ont le même vent, pour un classement équitable.
- **🧭 Carrière, pour ceux qui accrochent.** Des journées de 3 minutes, reprises avec son nom. Chaque soir, l'électricité vendue,
  moins les pièces, le carburant et les rotors remplacés, donne un budget pour améliorer le bateau à la base.
  Une mécanique s'ajoute chaque jour :
  - jour 1 : les pièces et la base ;
  - jour 2 : le carburant, le brouillard et la houle ;
  - jour 3 : le dépôt de pièces de l'OSS et les dauphins ;
  - jour 4 : les grains (au-delà de 1,5 m de houle, transfert impossible) et le défaut du transformateur de l'OSS (−50 %) ;
  - jour 5 : les défauts de câble et les incendies.

**Ce qu'on voit à l'écran**
- Le **vent** varie, avec des rafales et des accalmies, et la production suit la courbe de puissance des éoliennes : c'est une énergie intermittente.
- Une éolienne en défaut est d'abord **bridée à 40 %**. Négligée, elle passe en arrêt de sécurité, puis peut prendre feu et exploser.
  Si elle explose, toutes les éoliennes situées après elle sur le string sont coupées.
- Les **éoliennes fiabilisées sont dorées**. Des mouettes, des dauphins et un cargo animent la mer.

Le vocabulaire reste neutre vis-à-vis du constructeur : on parle de « défauts » et d'éoliennes « plus exposées » (houle, embruns),
jamais de matériel peu fiable. Pour retirer les incendies et les explosions, passez `incendies: false` dans `CONFIG`,
en haut du script : une éolienne négligée s'arrêtera alors simplement.

## Panneau organisateur

Sur l'accueil, **cliquez 5 fois rapidement sur le logo du parc** (en haut à gauche). Il n'y a pas de mot de passe.

- **Parties** : date, nom, mode, score, temps de jeu. On peut corriger un nom ou un score, supprimer des lignes ou tout effacer.
- **Carrières** : jour atteint, énergie cumulée, budget, temps total. On peut supprimer des carrières.
- On peut aussi changer le dossier des scores et télécharger les deux fichiers JSON.

Toutes les modifications sont aussitôt écrites dans les fichiers du dossier.

## Réglages utiles (dans `index.html`, objet `CONFIG` et `PARAMS`)

- `dureeShift` : durée d'un shift (30 s en Sprint, 60 s en Carrière).
- `incendies` : `false` pour désactiver le feu et les explosions.
- `prixMWh`, `prixPiece`, `prixPlein`, `prixRemplacement`, `stockOSS` : l'économie de la Carrière.
- `PARAMS.risqueFragile` / `risqueNormal` : la fréquence des défauts. Actuellement, il y en a environ 15 à 25 par Sprint selon la façon de jouer.

L'équilibrage a été vérifié avec un bot qui joue des centaines de parties. Dans tous les modes,
fiabiliser les éoliennes qui reviennent souvent divise le nombre de défauts par deux environ par rapport à
« courir d'une panne à l'autre ». En Carrière, cela rapporte aussi nettement plus de budget.
