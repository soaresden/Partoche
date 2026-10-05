# Compile l'APK signé de Partoche And Prof et régénère docs/ (sans Android Studio).
#   powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1                         -> version de android\app\build.gradle
#   powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1 -Version 1.0.6          -> passe en 1.0.6 (versionCode + 1)
#   powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1 -Publish                -> puis publie la release (tools\release.ps1)
# Outils attendus (une fois) : JDK 17 (winget install Microsoft.OpenJDK.17), Gradle 8.11.1 dans C:\Android\gradle-8.11.1,
# SDK Android dans C:\Android\sdk (platforms;android-35, build-tools;35.0.0). Clé de signature : android\keystore\msczplayer.jks.
param([string]$Version = '', [switch]$Publish)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gradleFile = Join-Path $root 'android\app\build.gradle'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path (Join-Path $root 'android\keystore\msczplayer.jks'))) { throw "Clé de signature absente : android\keystore\msczplayer.jks" }

# version : -Version change versionName et incrémente versionCode
$g = [IO.File]::ReadAllText($gradleFile)
if ($Version) {
  $code = [int]([regex]::Match($g, 'versionCode\s+(\d+)').Groups[1].Value) + 1
  $g = $g -replace "versionCode\s+\d+", "versionCode $code" -replace "versionName\s+'[^']*'", "versionName '$Version'"
  [IO.File]::WriteAllText($gradleFile, $g, $utf8)
}
$Version = [regex]::Match($g, "versionName\s+'([^']+)'").Groups[1].Value
Write-Host "Version $Version"

# outils
$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($jdk) { $env:JAVA_HOME = $jdk.FullName; $env:Path = "$($jdk.FullName)\bin;$env:Path" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'C:\Android\sdk' }
$gradle = 'C:\Android\gradle-8.11.1\bin\gradle.bat'
[IO.File]::WriteAllText((Join-Path $root 'android\local.properties'), "sdk.dir=$($env:ANDROID_HOME -replace '\\', '/')`n", $utf8)

# docs/ (GitHub Pages) = copie de web/ + config générique (comme tools/build-docs.sh)
[IO.File]::WriteAllText((Join-Path $root 'web\version.js'), "window.PARTOCHE_VERSION = '$Version'`n", $utf8)
$docs = Join-Path $root 'docs'
if (Test-Path $docs) { Remove-Item -Recurse -Force $docs }
Copy-Item -Recurse (Join-Path $root 'web') $docs
Copy-Item -Force (Join-Path $root 'tools\docs-config.js') (Join-Path $docs 'config.js')
New-Item -ItemType File (Join-Path $docs '.nojekyll') | Out-Null
Write-Host 'docs/ régénéré.'

# APK
& $gradle -p (Join-Path $root 'android') assembleRelease --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw "La compilation a échoué ($LASTEXITCODE)" }
$out = Join-Path $root 'android\app\build\outputs\apk\release\app-release.apk'
New-Item -ItemType Directory -Force (Join-Path $root 'release') | Out-Null
$apk = Join-Path $root "release\Partoche And Prof $Version.apk"
Copy-Item -Force $out $apk
Write-Host "APK : $apk ($([math]::Round((Get-Item $apk).Length / 1MB, 1)) Mo)"

if ($Publish) { & (Join-Path $PSScriptRoot 'release.ps1') -Version $Version }
