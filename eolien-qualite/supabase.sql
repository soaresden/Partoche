-- =====================================================================
--  « Gardez le parc en mouvement » — Semaine de la qualité 2026
--  Script à coller dans Supabase > SQL Editor > New query, puis « Run ».
--  Il peut être relancé sans risque (il ne supprime aucune donnée).
--
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- 1) Parties jouées (une ligne par partie Sprint ou par journée de Carrière)
create table if not exists public.scores (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  login          text        not null check (char_length(login)  between 1 and 64),
  pseudo         text        not null check (char_length(pseudo) between 1 and 24),
  source         text        not null default 'saisie' check (source in ('windows', 'sharepoint', 'saisie')),
  mode           text        not null default 'rapide' check (mode in ('rapide', 'carriere')),
  jour           integer     not null default 1 check (jour between 1 and 1000),
  score          integer     not null check (score between 0 and 100000),
  energie        integer     not null default 0 check (energie between 0 and 100000),
  reparations    integer     not null default 0 check (reparations    between 0 and 500),
  ameliorations  integer     not null default 0 check (ameliorations  between 0 and 100),
  pannes_evitees integer     not null default 0 check (pannes_evitees between 0 and 500),
  disponibilite  integer     not null default 0 check (disponibilite  between 0 and 100),
  combo_max      integer     not null default 0 check (combo_max      between 0 and 100),
  temps_jeu      integer     not null default 0 check (temps_jeu      between 0 and 86400),  -- secondes, visible en admin seulement
  langue         text        check (langue in ('fr', 'en')),
  version        text
);
-- (mise à niveau : accepte aussi les comptes Microsoft 365 détectés via SharePoint)
alter table public.scores drop constraint if exists scores_source_check;
alter table public.scores add constraint scores_source_check check (source in ('windows', 'sharepoint', 'saisie'));
create index if not exists scores_login_date_idx on public.scores (login, created_at desc);
create index if not exists scores_mode_idx       on public.scores (mode, score desc);

-- 2) Carrières sauvegardées (reprise avec pseudo + code à 4 chiffres)
create table if not exists public.carrieres (
  cle        text primary key,                       -- pseudo en minuscules
  pseudo     text not null check (char_length(pseudo) between 1 and 24),
  code_hash  text not null,                          -- code à 4 chiffres, haché
  login      text,                                   -- login Windows si connu
  jour       integer not null default 1 check (jour between 1 and 1000),
  total_mwh  integer not null default 0 check (total_mwh between 0 and 100000000),
  budget     integer not null default 0,
  temps_jeu  integer not null default 0 check (temps_jeu between 0 and 10000000),
  data       jsonb   not null,
  cree_le    timestamptz not null default now(),
  maj        timestamptz not null default now()
);

-- 3) Contrôles à l'ajout d'une partie : login normalisé, date imposée, anti-spam
create or replace function public.scores_avant_ajout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.login      := lower(btrim(new.login));
  new.pseudo     := btrim(new.pseudo);
  new.created_at := now();
  -- une partie dure au moins 90 s : on refuse deux envois du même joueur en moins de 45 s
  if exists (
    select 1 from public.scores s
    where s.login = new.login and s.created_at > now() - interval '45 seconds'
  ) then
    raise exception 'Trop de parties envoyées, patientez un peu';
  end if;
  return new;
end;
$$;

drop trigger if exists scores_avant_ajout on public.scores;
create trigger scores_avant_ajout
  before insert on public.scores
  for each row execute function public.scores_avant_ajout();

-- 4) Sécurité : le jeu peut AJOUTER une partie, mais ni lire les logins ni le
--    temps de jeu, ni modifier, ni supprimer. Tout le reste passe par des fonctions.
alter table public.scores    enable row level security;
alter table public.carrieres enable row level security;

revoke all on table public.scores    from anon, authenticated;
revoke all on table public.carrieres from anon, authenticated;
grant insert (login, pseudo, source, mode, jour, score, energie, reparations, ameliorations,
              pannes_evitees, disponibilite, combo_max, temps_jeu, langue, version)
  on public.scores to anon, authenticated;

drop policy if exists "le jeu ajoute des scores" on public.scores;
create policy "le jeu ajoute des scores"
  on public.scores for insert
  to anon, authenticated
  with check (true);

revoke execute on function public.scores_avant_ajout() from public, anon, authenticated;

-- 5) Fonctions publiques du jeu ----------------------------------------------

-- Classement Sprint : meilleur score de chaque joueur (depuis = null -> général)
drop function if exists public.classement(integer, timestamptz);
drop function if exists public.classement(integer, timestamptz, text);
create or replace function public.classement(nb integer default 10, depuis timestamptz default null,
                                             p_mode text default 'rapide')
returns table (rang bigint, pseudo text, score integer, ameliorations integer, jour integer,
               parties bigint, le timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with filtre as (
    select s.* from public.scores s
    where (depuis is null or s.created_at >= depuis)
      and s.mode = coalesce(p_mode, 'rapide')
  ), meilleurs as (
    select distinct on (f.login)
           f.login, f.pseudo, f.score, f.ameliorations, f.jour, f.created_at,
           count(*) over (partition by f.login) as parties
    from filtre f
    order by f.login, f.score desc, f.created_at asc
  )
  select rank() over (order by m.score desc), m.pseudo, m.score, m.ameliorations, m.jour,
         m.parties, m.created_at
  from meilleurs m
  order by m.score desc, m.created_at asc
  limit least(greatest(coalesce(nb, 10), 1), 100);
$$;

-- Rang d'un score parmi les autres joueurs
drop function if exists public.mon_rang(integer, text, timestamptz);
drop function if exists public.mon_rang(integer, text, timestamptz, text);
create or replace function public.mon_rang(p_score integer, p_login text default null,
                                           depuis timestamptz default null, p_mode text default 'rapide')
returns table (rang bigint, joueurs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with meilleurs as (
    select s.login, max(s.score) as best
    from public.scores s
    where (depuis is null or s.created_at >= depuis)
      and s.mode = coalesce(p_mode, 'rapide')
      and s.login is distinct from lower(btrim(p_login))
    group by s.login
  )
  select 1 + count(*) filter (where m.best > p_score), count(*) + 1
  from meilleurs m;
$$;

-- Classement Carrière : énergie cumulée sur toutes les journées
create or replace function public.classement_carriere(nb integer default 10)
returns table (rang bigint, pseudo text, jour integer, total_mwh integer)
language sql
stable
security definer
set search_path = ''
as $$
  select rank() over (order by c.total_mwh desc), c.pseudo, c.jour, c.total_mwh
  from public.carrieres c
  order by c.total_mwh desc, c.maj asc
  limit least(greatest(coalesce(nb, 10), 1), 100);
$$;

-- Sauvegarde d'une carrière : crée la carrière au premier appel, puis exige le même code
create or replace function public.sauver_carriere(p_pseudo text, p_code text, p_login text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text := lower(btrim(p_pseudo));
  h text;
begin
  if p_code is null or p_code !~ '^[0-9]{4}$' then raise exception 'Code invalide'; end if;
  if char_length(k) not between 1 and 24 then raise exception 'Pseudo invalide'; end if;
  if pg_column_size(p_data) > 60000 then raise exception 'Sauvegarde trop volumineuse'; end if;
  select c.code_hash into h from public.carrieres c where c.cle = k;
  if h is null then
    insert into public.carrieres (cle, pseudo, code_hash, login, jour, total_mwh, budget, temps_jeu, data)
    values (k, btrim(p_pseudo), extensions.crypt(p_code, extensions.gen_salt('bf')), nullif(lower(btrim(p_login)), ''),
            (p_data->>'jour')::integer, (p_data->>'totalMWh')::integer, (p_data->>'budget')::integer,
            (p_data->>'tempsJeu')::integer, p_data);
  elsif extensions.crypt(p_code, h) <> h then
    perform pg_sleep(1);
    raise exception 'Code incorrect';
  else
    update public.carrieres c
       set pseudo = btrim(p_pseudo), login = coalesce(nullif(lower(btrim(p_login)), ''), c.login),
           jour = (p_data->>'jour')::integer, total_mwh = (p_data->>'totalMWh')::integer,
           budget = (p_data->>'budget')::integer, temps_jeu = (p_data->>'tempsJeu')::integer,
           data = p_data, maj = now()
     where c.cle = k;
  end if;
end;
$$;

-- Reprise d'une carrière depuis n'importe quel poste
create or replace function public.charger_carriere(p_pseudo text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  select c.code_hash, c.data into r from public.carrieres c where c.cle = lower(btrim(p_pseudo));
  if not found then raise exception 'Aucune carriere'; end if;
  if p_code is null or extensions.crypt(p_code, r.code_hash) <> r.code_hash then
    perform pg_sleep(1);
    raise exception 'Code incorrect';
  end if;
  return r.data;
end;
$$;

revoke execute on function public.classement(integer, timestamptz, text)          from public;
revoke execute on function public.mon_rang(integer, text, timestamptz, text)       from public;
revoke execute on function public.classement_carriere(integer)                     from public;
revoke execute on function public.sauver_carriere(text, text, text, jsonb)         from public;
revoke execute on function public.charger_carriere(text, text)                     from public;
grant  execute on function public.classement(integer, timestamptz, text)          to anon, authenticated;
grant  execute on function public.mon_rang(integer, text, timestamptz, text)       to anon, authenticated;
grant  execute on function public.classement_carriere(integer)                     to anon, authenticated;
grant  execute on function public.sauver_carriere(text, text, text, jsonb)         to anon, authenticated;
grant  execute on function public.charger_carriere(text, text)                     to anon, authenticated;

-- 6) Panneau organisateur (5 clics rapides sur le logo du jeu) -----------
--    Par défaut : SANS mot de passe (à la demande de l'organisation).
--    Attention : la clé publishable étant visible dans la page, toute personne qui
--    la récupère peut alors appeler les fonctions admin_* (lire les logins et le temps
--    de jeu, modifier ou effacer). Pour remettre un mot de passe, voir plus bas.
create schema if not exists prive;
revoke all on schema prive from public, anon, authenticated;

create table if not exists prive.reglages (
  cle    text primary key,
  valeur text not null
);
revoke all on table prive.reglages from public, anon, authenticated;

-- Panneau sans mot de passe : on retire celui qui aurait été défini auparavant.
delete from prive.reglages where cle = 'mdp_admin';
-- Pour REMETTRE un mot de passe (le jeu le demandera alors automatiquement) :
--   insert into prive.reglages (cle, valeur)
--   values ('mdp_admin', extensions.crypt('VotreMotDePasse', extensions.gen_salt('bf')))
--   on conflict (cle) do update set valeur = excluded.valeur;

create or replace function prive.verifier(mdp text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare h text;
begin
  select r.valeur into h from prive.reglages r where r.cle = 'mdp_admin';
  if h is null then return; end if;   -- aucun mot de passe défini : accès libre
  if mdp is null or extensions.crypt(mdp, h) <> h then
    perform pg_sleep(1);  -- freine les essais en série
    raise exception 'Mot de passe incorrect';
  end if;
end;
$$;
revoke execute on function prive.verifier(text) from public, anon, authenticated;

create or replace function public.admin_scores(mdp text)
returns setof public.scores
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform prive.verifier(mdp);
  return query select * from public.scores s order by s.created_at desc limit 5000;
end;
$$;

create or replace function public.admin_modifier(mdp text, p_id bigint, p_pseudo text, p_score integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform prive.verifier(mdp);
  update public.scores
     set pseudo = coalesce(nullif(btrim(p_pseudo), ''), pseudo),
         score  = coalesce(p_score, score)
   where id = p_id;
end;
$$;

create or replace function public.admin_supprimer(mdp text, p_ids bigint[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  perform prive.verifier(mdp);
  delete from public.scores where id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.admin_vider(mdp text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  perform prive.verifier(mdp);
  delete from public.scores where true;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.admin_carrieres(mdp text)
returns table (cle text, pseudo text, login text, jour integer, total_mwh integer, budget integer,
               temps_jeu integer, cree_le timestamptz, maj timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform prive.verifier(mdp);
  return query select c.cle, c.pseudo, c.login, c.jour, c.total_mwh, c.budget, c.temps_jeu, c.cree_le, c.maj
               from public.carrieres c order by c.maj desc;
end;
$$;

create or replace function public.admin_supprimer_carrieres(mdp text, p_cles text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  perform prive.verifier(mdp);
  delete from public.carrieres where cle = any(p_cles);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.admin_scores(text)                           from public;
revoke execute on function public.admin_modifier(text, bigint, text, integer)  from public;
revoke execute on function public.admin_supprimer(text, bigint[])              from public;
revoke execute on function public.admin_vider(text)                            from public;
revoke execute on function public.admin_carrieres(text)                        from public;
revoke execute on function public.admin_supprimer_carrieres(text, text[])      from public;
grant  execute on function public.admin_scores(text)                           to anon, authenticated;
grant  execute on function public.admin_modifier(text, bigint, text, integer)  to anon, authenticated;
grant  execute on function public.admin_supprimer(text, bigint[])              to anon, authenticated;
grant  execute on function public.admin_vider(text)                            to anon, authenticated;
grant  execute on function public.admin_carrieres(text)                        to anon, authenticated;
grant  execute on function public.admin_supprimer_carrieres(text, text[])      to anon, authenticated;

-- =====================================================================
--  Requêtes utiles pour l'organisateur (à lancer dans le SQL Editor)
-- =====================================================================
-- Toutes les parties, avec login Windows et temps de jeu :
--   select created_at, login, pseudo, mode, jour, score, temps_jeu from public.scores order by created_at desc;
-- Temps de jeu total par joueur :
--   select login, count(*) as parties, sum(temps_jeu) / 60 as minutes from public.scores group by login order by minutes desc;
-- Podium Sprint de la semaine :
--   select * from public.classement(10, '2026-11-09', 'rapide');
-- Remettre les classements à zéro (après les tests !) :
--   truncate public.scores restart identity;  delete from public.carrieres;
