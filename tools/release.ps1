# Publie une release GitHub de Partoche And Prof avec l'APK, sans outil à installer (API GitHub).
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1            -> version lue dans android\app\build.gradle
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Clean     -> supprime d'abord toutes les anciennes releases
# Il faut un jeton GitHub (une fois) : github.com/settings/personal-access-tokens -> « Generate new token »
#   Repository access : Only select repositories -> Partoche ; Permissions : Contents -> Read and write.
# Le plus simple : colle-le seul dans mytoken.txt, à la racine du dépôt (ignoré par git).
# Ou bien, dans PowerShell : [Environment]::SetEnvironmentVariable('GITHUB_TOKEN','<jeton>','User')
param([string]$Version = '', [switch]$Clean)
$ErrorActionPreference = 'Stop'
$repo = 'soaresden/Partoche'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $m = Select-String -Path (Join-Path $root 'android\app\build.gradle') -Pattern "versionName\s+'([^']+)'"
  $Version = $m.Matches[0].Groups[1].Value
}
# APK : dossier release\ du dépôt (ignoré par git, comme tous les .apk)
$apk = Join-Path $root "release\Partoche And Prof $Version.apk"
if (-not (Test-Path $apk)) { $apk = Read-Host "APK introuvable ($apk). Chemin de l'APK" }
# jeton : mytoken.txt à la racine du dépôt (jamais publié, voir .gitignore), sinon GITHUB_TOKEN, sinon on le demande
$token = ''
$tokFile = Join-Path $root 'mytoken.txt'
if (Test-Path $tokFile) { $token = (Get-Content $tokFile -Raw).Trim() }
if (-not $token) { $token = $env:GITHUB_TOKEN }
if (-not $token) {
  $s = Read-Host 'Jeton GitHub' -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
$h = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$api = "https://api.github.com/repos/$repo"

if ($Clean) {
  $rels = Invoke-RestMethod "$api/releases?per_page=100" -Headers $h
  foreach ($r in $rels) {
    Write-Host "Suppression de $($r.name) ($($r.tag_name))"
    Invoke-RestMethod -Method Delete "$api/releases/$($r.id)" -Headers $h | Out-Null
    try { Invoke-RestMethod -Method Delete "$api/git/refs/tags/$($r.tag_name)" -Headers $h | Out-Null } catch { }
  }
}
# même version déjà publiée : on la remplace
try {
  $old = Invoke-RestMethod "$api/releases/tags/v$Version" -Headers $h
  Invoke-RestMethod -Method Delete "$api/releases/$($old.id)" -Headers $h | Out-Null
  try { Invoke-RestMethod -Method Delete "$api/git/refs/tags/v$Version" -Headers $h | Out-Null } catch { }
} catch { }

$apkUrl = "https://github.com/$repo/releases/latest/download/Partoche.apk"
$notes = @"
## 📱 Télécharger l'appli (tablette Android de l'élève)
**➡️ [Partoche.apk]($apkUrl)**

## 🚀 Première fois ? Le mode d'emploi pas à pas
https://soaresden.github.io/Partoche/demarrer.html

## 🧑‍🏫 Page du prof (ordinateur ou iPad, rien à installer)
https://soaresden.github.io/Partoche/
"@
$body = @{ tag_name = "v$Version"; target_commitish = 'main'; name = "Partoche And Prof $Version"; body = $notes; make_latest = 'true' } | ConvertTo-Json
$rel = Invoke-RestMethod -Method Post "$api/releases" -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8'
Write-Host "Release créée : $($rel.html_url)"
# nom fixe « Partoche.apk » : le lien …/releases/latest/download/Partoche.apk marche toujours
Invoke-RestMethod -Method Post "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets?name=Partoche.apk" -Headers $h -InFile $apk -ContentType 'application/vnd.android.package-archive' | Out-Null
Write-Host "APK envoyé. Lien direct à donner aux élèves : $apkUrl"
