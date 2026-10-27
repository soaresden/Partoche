# Gardez le parc en mouvement — Semaine de la qualité 2026

Jeu HTML (un seul fichier, FR / EN) pour la Semaine mondiale de la qualité, du 9 au 13 novembre 2026,
sur le thème « Quality: Powering Performance ». Il se joue sur la vraie implantation du parc de Courseulles :
64 éoliennes, 13 strings, l'OSS et des distances réelles.

| Fichier | Rôle |
| --- | --- |
| `index.html` | le jeu complet : accueil en onglets, classements, Sprint, Carrière, base et panneau organisateur |
| `supabase.sql` | tables, sécurité et fonctions à créer dans Supabase |

## Mise en route

1. **Supabase** : ouvrez *SQL Editor › New query* et collez `supabase.sql`.
   Cliquez sur *Run*.
   Le script peut être relancé sans risque. Si vous l'avez déjà passé, relancez-le simplement :
   il autorise désormais la valeur `sharepoint` dans la colonne `source`.
2. **SharePoint** : déposez le fichier dans la bibliothèque *Ressources du site* (*Site Assets*) en le renommant **`jeu.aspx`**,
   puis ouvrez ce lien `.aspx`.
   - SharePoint Online télécharge les `.html` au lieu de les afficher. En `.aspx`, la page s'affiche
     si les scripts personnalisés sont autorisés sur le site (réglage administrateur *DenyAddAndCustomizePages*). À voir avec votre IT :
     Microsoft encadre de plus en plus ce réglage.
   - Si le fichier se télécharge au lieu de s'afficher, c'est ce réglage qui bloque.

**Identification automatique** : quand la page est affichée dans SharePoint, le jeu interroge le site (`/_api/web/currentuser`)
avec la session de la personne. Il récupère son e-mail (enregistré comme login) et pré-remplit son nom, sans aucune saisie.
Hors SharePoint, le jeu fonctionne aussi : le joueur saisit son nom, qui sert alors d'identifiant.

## Les deux façons de jouer

- **⚡ Sprint 90 s** : une journée (6 h → 22 h) en 3 shifts de 30 s. Classement du jour et classement général.
- Les éoliennes fiabilisées passent à l'or : or pâle au niveau 1, or vif et scintillant au niveau 2.
- **🧭 Carrière** : des journées de 3 minutes, sauvegardées. L'électricité vendue rapporte un budget,
  dont on déduit les pièces et le carburant (le coût de la non-qualité apparaît chaque soir). Ce budget sert à améliorer
  le bateau à la base : moteurs, soute, réservoir, formation de l'équipe, radar météo et supervision SCADA.
  La difficulté monte au fil des jours : mammifères marins au jour 2, grains (Hs > 1,5 m) au jour 3, défauts de câble au jour 4.
  - **Reprise** avec *nom + code à 4 chiffres*, depuis n'importe quel poste. Le code est haché côté Supabase.
  - Classement Carrière : énergie cumulée.

Le **temps de jeu** de chaque partie est enregistré (`temps_jeu`) ; il n'est visible que dans le panneau organisateur.

## Panneau organisateur

Sur la page d'accueil, **cliquez 5 fois rapidement sur le logo du parc** (en haut à gauche) : le panneau s'ouvre directement, sans mot de passe.

- **Parties** : liste avec login (e-mail Microsoft 365), mode, score et temps de jeu. On peut y corriger un pseudo ou un score, supprimer des lignes ou tout effacer. Le filtre affiche le temps de jeu cumulé.
- **Carrières** : jour atteint, énergie cumulée, budget, temps total. On peut supprimer des carrières.

⚠️ Sans mot de passe, quelqu'un qui récupère la clé publishable (visible dans la page) peut aussi lire les logins et le temps de jeu, ou effacer les scores.
Pour remettre un mot de passe, exécutez la requête `insert into prive.reglages …` indiquée en commentaire à la section 6 de `supabase.sql` : le jeu le demandera automatiquement.

## Réglages utiles (dans `index.html`)

- `CONFIG.dureeShift` : durée d'un shift (30 s en Sprint, 60 s en Carrière).
- `CONFIG.prixMWh`, `prixPiece`, `prixPlein` : économie de la Carrière (en k€).
- `PARAMS` : vitesse du bateau, pièces à bord, durées d'intervention, fréquence des pannes…
- `AMELIORATIONS` : prix et effets des améliorations.
- `CONFIG.debutSemaine` : cible du compte à rebours de l'accueil.

L'équilibrage a été vérifié avec un bot qui joue des centaines de parties : fiabiliser les récidivistes
rapporte toujours plus que de courir d'une panne à l'autre. Le rythme a été calmé : environ une panne toutes les 4 à 6 secondes, avec un démarrage tranquille.

## Remarques

- Après vos tests : `truncate public.scores restart identity; delete from public.carrieres;` dans le SQL Editor.
- Le classement est public et le jeu tourne dans le navigateur : un joueur déterminé pourrait envoyer un faux score.
  Le panneau organisateur sert à faire le ménage.
