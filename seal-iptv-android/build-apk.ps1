# Seal IPTV for Fire TV — build-apk.ps1
# Builds the web part from ..\seal-iptv (web\build.js), then the signed APK, and copies it to
# ..\dist\SealIPTV-FireTV-<version>.apk. Needs keystore.properties + keystore\ (never share them).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Push-Location web; node build.js; node test-shims.js | Select-Object -Last 1; Pop-Location
$g = (Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.11.1-bin\*\gradle-8.11.1\bin\gradle.bat" | Select-Object -First 1).FullName
& $g assembleRelease --no-daemon -q
$ver = (Get-Content ..\seal-iptv\package.json -Raw | ConvertFrom-Json).version   # the same version as Windows
New-Item -ItemType Directory -Force ..\dist | Out-Null
Copy-Item app\build\outputs\apk\release\app-release.apk "..\dist\SealIPTV-FireTV-$ver.apk" -Force
Write-Host "APK: $((Resolve-Path "..\dist\SealIPTV-FireTV-$ver.apk").Path)"
