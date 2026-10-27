# Gardez le parc en mouvement — Semaine de la qualité 2026

Jeu HTML (un seul fichier, FR / EN) pour la Semaine mondiale de la qualité, du 9 au 13 novembre 2026,
sur le thème « Quality: Powering Performance ». Il se joue sur la vraie implantation du parc de Courseulles :
64 éoliennes, 13 strings, l'OSS et des distances réelles.

| Fichier | Rôle |
| --- | --- |
| `index.html` | le jeu complet : accueil, classements, Sprint, Carrière, base et panneau organisateur |
| `supabase.sql` | tables, sécurité et fonctions à créer dans Supabase |
| `Jouer.bat` | lanceur Windows qui transmet l'identifiant de session (`%USERNAME%`) |

## Mise en route (≈ 10 minutes)

1. **Supabase** : ouvrez *SQL Editor › New query* et collez `supabase.sql`.
   **Avant de lancer**, remplacez `ChangezMoi-2026` (section 6) par votre mot de passe organisateur, puis cliquez sur *Run*.
   Le script peut être relancé sans risque : il ne supprime aucune donnée et n'écrase pas le mot de passe.
2. **Hébergement** : publiez `index.html` (GitHub Pages, comme pour EDF-COUGame, ou l'intranet).
   L'URL et la clé Supabase sont déjà dans `CONFIG`, en haut du script.
3. **Lanceur** : dans `Jouer.bat`, remplacez l'adresse `JEU=` par celle du jeu, puis diffusez le fichier
   (par mail, sur le bureau d'un poste de démonstration ou via un raccourci).

> Un navigateur ne peut pas lire le login Windows : c'est `Jouer.bat` qui l'ajoute à l'adresse (`?login=…`).
> Sans lanceur, le jeu fonctionne aussi, mais le login enregistré est alors le pseudo saisi.

## Les deux façons de jouer

- **⚡ Sprint 90 s** : une journée (6 h → 22 h) en 3 shifts de 30 s. Classement du jour et classement général.
- **🧭 Carrière** : des journées de 3 minutes, sauvegardées. L'électricité vendue rapporte un budget,
  dont on déduit les pièces et le carburant (le coût de la non-qualité apparaît chaque soir). Ce budget sert à améliorer
  le bateau à la base : moteurs, soute, réservoir, formation de l'équipe, radar météo et supervision SCADA.
  La difficulté monte au fil des jours : mammifères marins au jour 2, grains (Hs > 1,5 m) au jour 3, défauts de câble au jour 4.
  - **Reprise** avec *nom + code à 4 chiffres*, depuis n'importe quel poste. Le code est haché côté Supabase.
  - Classement Carrière : énergie cumulée.

Le **temps de jeu** de chaque partie est enregistré (`temps_jeu`) ; il n'est visible que dans le panneau organisateur.

## Panneau organisateur

Sur la page d'accueil, **cliquez 5 fois rapidement sur le logo rouge** (en haut à gauche), puis saisissez le mot de passe.

- **Parties** : liste avec login Windows, mode, score et temps de jeu. On peut y corriger un pseudo ou un score, supprimer des lignes ou tout effacer. Le filtre affiche le temps de jeu cumulé.
- **Carrières** : jour atteint, énergie cumulée, budget, temps total. On peut supprimer des carrières.

Toutes ces actions sont vérifiées par Supabase avec le mot de passe : la clé publishable seule ne permet ni de lire les logins ni de modifier quoi que ce soit.

## Réglages utiles (dans `index.html`)

- `CONFIG.dureeShift` : durée d'un shift (30 s en Sprint, 60 s en Carrière).
- `CONFIG.prixMWh`, `prixPiece`, `prixPlein` : économie de la Carrière (en k€).
- `PARAMS` : vitesse du bateau, pièces à bord, durées d'intervention, fréquence des pannes…
- `AMELIORATIONS` : prix et effets des améliorations.
- `CONFIG.debutSemaine` : cible du compte à rebours de l'accueil.

L'équilibrage a été vérifié avec un bot qui joue des centaines de parties : fiabiliser les récidivistes
rapporte toujours plus que de courir d'une panne à l'autre. L'écart est d'environ 4 % en Sprint et de 7 à 9 % en Carrière ;
il se creuse pour un joueur humain, plus lent à réagir.

## Remarques

- Après vos tests : `truncate public.scores restart identity; delete from public.carrieres;` dans le SQL Editor.
- Le classement est public et le jeu tourne dans le navigateur : un joueur déterminé pourrait envoyer un faux score.
  Le panneau organisateur sert à faire le ménage.
