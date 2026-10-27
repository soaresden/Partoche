@echo off
rem ==================================================================
rem  Gardez le parc en mouvement - Semaine de la qualite 2026
rem  Lance le jeu en transmettant votre identifiant Windows, pour que
rem  vos scores et votre temps de jeu soient rattaches a votre compte.
rem
rem  A ADAPTER : l'adresse ou le jeu est publie (GitHub Pages, intranet...)
rem ==================================================================
set "JEU=https://soaresden.github.io/EolienQualite/"

start "" "%JEU%?login=%USERNAME%"

rem  Variante si index.html est copie a cote de ce fichier (sans hebergement) :
rem  start "" msedge "file:///%~dp0index.html?login=%USERNAME%"
