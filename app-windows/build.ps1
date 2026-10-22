# The tray on Windows: its tests, then the app published self-contained into app-windows\out, signed when an
# Authenticode certificate is given (LIFE_SIGN_PFX, a .pfx path, and LIFE_SIGN_PASSWORD), unsigned until then. The
# certificate goes into the user's store, so signtool picks it by thumbprint and its password never reaches a command
# line. The tray alone: the helper (helper\life.exe) joins it once it runs on Windows (phase 3).
$ErrorActionPreference = "Stop"
dotnet test "$PSScriptRoot\Life.Tests"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
dotnet publish "$PSScriptRoot\Life.Tray" -c Release -o "$PSScriptRoot\out"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if (-not $env:LIFE_SIGN_PFX) { "No certificate given: the tray stays unsigned."; exit 0 }
$password = ConvertTo-SecureString $env:LIFE_SIGN_PASSWORD -AsPlainText -Force
$cert = Import-PfxCertificate -FilePath $env:LIFE_SIGN_PFX -CertStoreLocation Cert:\CurrentUser\My -Password $password
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Select-Object -Last 1
& $signtool sign /sha1 $cert.Thumbprint /s My /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "$PSScriptRoot\out\Life.exe"
exit $LASTEXITCODE
