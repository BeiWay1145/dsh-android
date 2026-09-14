# Build the on-device bridge APK.
#
# Deliberately does NOT use Gradle: the bridge is three classes and two resource
# files, and the SDK's own aapt2/d8/apksigner do the whole job in seconds. It also
# keeps the build runnable on a machine with only cmdline-tools + a JDK.
#
# Usage:  pwsh -File scripts/build-bridge.ps1 [-Sdk <path>]
param(
  [string]$Sdk = $env:ANDROID_SDK_ROOT,
  [string]$Jdk = $env:JAVA_HOME
)

$ErrorActionPreference = 'Stop'
if (-not $Sdk) { $Sdk = 'C:\Users\BeiWay1145\AppData\Local\Android\Sdk' }
if (-not $Jdk) { $Jdk = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot' }
$env:JAVA_HOME = $Jdk

$proj = Join-Path $PSScriptRoot '..\android-bridge'
$out = Join-Path $proj 'build'
$bt = Join-Path $Sdk 'build-tools\34.0.0'
$platform = Join-Path $Sdk 'platforms\android-34\android.jar'
$d8 = Join-Path $Sdk 'cmdline-tools\latest\bin\d8.bat'

foreach ($tool in @("$bt\aapt2.exe", "$bt\apksigner.bat", "$bt\zipalign.exe", $platform, $d8, "$Jdk\bin\javac.exe", "$Jdk\bin\keytool.exe")) {
  if (-not (Test-Path $tool)) { throw "missing build tool: $tool (pass -Sdk/-Jdk or install the SDK)" }
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path "$out\classes", "$out\dex", "$out\gen" -Force | Out-Null

Write-Host '1/5 aapt2 compile'
& "$bt\aapt2.exe" compile --dir "$proj\res" -o "$out\res.zip"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '2/5 aapt2 link'
& "$bt\aapt2.exe" link -o "$out\base.apk" -I $platform --manifest "$proj\AndroidManifest.xml" -R "$out\res.zip" --java "$out\gen" --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '3/5 javac'
# -classpath (not -bootclasspath): javac rejects a boot classpath together with a
# modern -source level, and the Android types must come from android.jar.
$sources = @(Get-ChildItem "$proj\java" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += @(Get-ChildItem "$out\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
& "$Jdk\bin\javac.exe" -classpath $platform -d "$out\classes" -encoding UTF-8 $sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '4/5 d8'
$classes = @(Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& $d8 --lib $platform --min-api 26 --output "$out\dex" $classes
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Host '5/5 package + sign'
Copy-Item "$out\base.apk" "$out\unsigned.apk" -Force
& "$Jdk\bin\jar.exe" uf "$out\unsigned.apk" -C "$out\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw 'jar update failed' }
& "$bt\zipalign.exe" -f 4 "$out\unsigned.apk" "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

$ks = Join-Path $proj 'debug.keystore'
if (-not (Test-Path $ks)) {
  & "$Jdk\bin\keytool.exe" -genkeypair -keystore $ks -storepass android -keypass android -alias dshbridge -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=DSH Bridge, OU=dev, O=beiway1145, C=CN'
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
$apk = Join-Path $proj 'dsh-bridge.apk'
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --out $apk "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

$item = Get-Item $apk
Write-Host "built $($item.FullName) ($($item.Length) bytes)"