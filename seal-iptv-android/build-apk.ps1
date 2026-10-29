# Seal IPTV for Fire TV — build-apk.ps1
# Builds the web part from ..\seal-iptv (web\build.js), then the signed APK, and copies it to
# ..\dist\SealIPTV-FireTV-<version>.apk. Needs keystore.properties + keystore\ (never share them).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Push-Location web; node build.js; node test-shims.js | Select-Object -Last 1; node test-pieces.js | Select-Object -Last 1; Pop-Location
$g = (Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.11.1-bin\*\gradle-8.11.1\bin\gradle.bat" | Select-Object -First 1).FullName
& $g assembleRelease --no-daemon -q
# a failed build left the last APK in place: never ship that (1.5.0 nearly went out with 1.4.2's APK)
if ($LASTEXITCODE -ne 0) { throw "The APK build failed (gradle exit $LASTEXITCODE)." }
$ver = (Get-Content ..\seal-iptv\package.json -Raw | ConvertFrom-Json).version   # the same version as Windows
$code = [regex]::Match((Get-Content app\build.gradle -Raw), 'versionCode\s+(\d+)').Groups[1].Value
$aapt = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools\*\aapt.exe", "C:\Android\Sdk\build-tools\*\aapt.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1
if ($aapt) {
  $badge = (& $aapt.FullName dump badging app\build\outputs\apk\release\app-release.apk | Select-Object -First 1)
  if ($badge -notmatch "versionCode='$code' versionName='$([regex]::Escape($ver))'") { throw "The APK isn't $ver ($code): $badge" }
}
New-Item -ItemType Directory -Force ..\dist | Out-Null
Copy-Item app\build\outputs\apk\release\app-release.apk "..\dist\SealIPTV-FireTV-$ver.apk" -Force
Write-Host "APK: $((Resolve-Path "..\dist\SealIPTV-FireTV-$ver.apk").Path)"
