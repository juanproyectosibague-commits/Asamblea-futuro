$ErrorActionPreference = 'Stop'
$projectRoot = 'C:\Users\Juan Ramirez\Documents\Codex\2026-09-29\rea\outputs'
$importer = 'C:\Users\Juan Ramirez\Documents\Codex\2026-09-30\act-a-como-un-ingeniero-full\outputs\run-ribera-import.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'No se encontró Node.js en este equipo.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) {
  throw "No se encontró el proyecto en: $projectRoot"
}
if (-not (Test-Path -LiteralPath $importer)) {
  throw "No se encontró el importador en: $importer"
}

Set-Location -LiteralPath $projectRoot
$secureUrl = Read-Host 'Nueva External Database URL de Render (entrada oculta)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
try {
  $databaseUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
$nit = Read-Host 'NIT oficial de Ribera Campestre P.H. según el RUT (base-DV)'
if (($nit -replace '[^0-9]', '') -ne '9020699486') {
  $databaseUrl = $null
  $secureUrl.Dispose()
  throw 'El NIT no coincide con el del RUT verificado. No se abrió una conexión.'
}

try {
  $env:DATABASE_URL = $databaseUrl
  $env:RIBERA_NIT = $nit
  & node $importer
  if ($LASTEXITCODE -ne 0) {
    throw "El importador terminó con código $LASTEXITCODE. Revisa el resultado anterior; la URL no se muestra."
  }
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:RIBERA_NIT -ErrorAction SilentlyContinue
  $databaseUrl = $null
  $nit = $null
  $secureUrl.Dispose()
}
