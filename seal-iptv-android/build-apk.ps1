# Seal IPTV for Fire TV + Android phones — build-apk.ps1
# Builds the web part from ..\seal-iptv (web\build.js), then both signed APKs (the same code, two apps:
# "tv" = Fire TV / Google TV, "mobile" = phones), and copies them to
#   ..\dist\SealIPTV-FireTV-<version>.apk   and   ..\dist\SealIPTV-Android-<version>.apk
# Needs keystore.properties + keystore\ (never share them).   -Only tv | mobile: just that one.
param([ValidateSet('', 'tv', 'mobile')][string]$Only = '')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Push-Location web; node build.js; node test-shims.js | Select-Object -Last 1; node test-pieces.js | Select-Object -Last 1; Pop-Location
$g = (Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.11.1-bin\*\gradle-8.11.1\bin\gradle.bat" | Select-Object -First 1).FullName
$flavors = if ($Only) { @($Only) } else { @('tv', 'mobile') }
$tasks = $flavors | ForEach-Object { "assemble$((Get-Culture).TextInfo.ToTitleCase($_))Release" }
& $g @tasks --no-daemon -q
# a failed build left the last APK in place: never ship that (1.5.0 nearly went out with 1.4.2's APK)
if ($LASTEXITCODE -ne 0) { throw "The APK build failed (gradle exit $LASTEXITCODE)." }
$ver = (Get-Content ..\seal-iptv\package.json -Raw | ConvertFrom-Json).version   # the same version as Windows
$code = [regex]::Match((Get-Content app\build.gradle -Raw), 'versionCode\s+(\d+)').Groups[1].Value
$aapt = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools\*\aapt.exe", "C:\Android\Sdk\build-tools\*\aapt.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1
New-Item -ItemType Directory -Force ..\dist | Out-Null
$names = @{ tv = 'FireTV'; mobile = 'Android' }
$ids = @{ tv = 'com.sealiptv.tv'; mobile = 'com.sealiptv.mobile' }
foreach ($f in $flavors) {
  $built = "app\build\outputs\apk\$f\release\app-$f-release.apk"
  if ($aapt) {
    $badge = (& $aapt.FullName dump badging $built | Select-Object -First 1)
    if ($badge -notmatch "name='$([regex]::Escape($ids[$f]))' versionCode='$code' versionName='$([regex]::Escape($ver))'") { throw "The $f APK isn't $($ids[$f]) $ver ($code): $badge" }
  }
  $to = "..\dist\SealIPTV-$($names[$f])-$ver.apk"
  Copy-Item $built $to -Force
  Write-Host "APK ($f): $((Resolve-Path $to).Path)"
}
