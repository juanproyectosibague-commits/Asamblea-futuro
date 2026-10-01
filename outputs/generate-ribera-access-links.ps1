$ErrorActionPreference = 'Stop'

$projectRoot = 'C:\Users\Juan Ramirez\Documents\Codex\2026-09-29\rea\outputs'
$node = 'C:\Users\Juan Ramirez\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$generator = 'C:\Users\Juan Ramirez\Documents\Codex\2026-09-30\act-a-como-un-ingeniero-full\outputs\generate-ribera-access-links.mjs'

if (-not (Test-Path -LiteralPath $node)) { throw 'No se encontró el Node.js integrado de Codex.' }
if (-not (Test-Path -LiteralPath $generator)) { throw 'No se encontró el generador de enlaces.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\pg'))) { throw 'Falta la dependencia pg en el proyecto local.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\jsonwebtoken'))) { throw 'Falta la dependencia jsonwebtoken en el proyecto local.' }

function ConvertFrom-SecureInput {
  param([Parameter(Mandatory = $true)][Security.SecureString]$Value)
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$secureDatabaseUrl = Read-Host 'External Database URL actual de ribera-db (se verá oculta)' -AsSecureString
$secureJwtSecret = Read-Host 'JWT_SECRET NUEVO configurado en Render (se verá oculto)' -AsSecureString
$databaseUrl = ConvertFrom-SecureInput $secureDatabaseUrl
$jwtSecret = ConvertFrom-SecureInput $secureJwtSecret

try {
  if ($databaseUrl -notmatch '^postgres(ql)?://') { throw 'La URL no tiene el formato PostgreSQL esperado.' }
  if ([Text.Encoding]::UTF8.GetByteCount($jwtSecret) -lt 32) { throw 'JWT_SECRET debe tener al menos 32 bytes.' }

  $env:DATABASE_URL = $databaseUrl
  $env:JWT_SECRET = $jwtSecret
  $env:JWT_ISSUER = 'https://asamblea-futuro.onrender.com'
  $env:JWT_AUDIENCE = 'ph-votaciones-api'
  $env:PUBLIC_BASE_URL = 'https://asamblea-futuro.onrender.com'
  $env:RIBERA_NIT = '902069948-6'

  Push-Location -LiteralPath $projectRoot
  try {
    & $node $generator
    if ($LASTEXITCODE -ne 0) { throw "El generador terminó con código $LASTEXITCODE." }
  } finally {
    Pop-Location
  }

  Write-Output 'Archivos creados en esta carpeta:'
  Write-Output (Join-Path (Split-Path -Parent $generator) 'ribera-campestre-access-links.csv')
  Write-Output (Join-Path (Split-Path -Parent $generator) 'ribera-campestre-admin-link.txt')
} finally {
  Remove-Item Env:DATABASE_URL,Env:JWT_SECRET,Env:JWT_ISSUER,Env:JWT_AUDIENCE,Env:PUBLIC_BASE_URL,Env:RIBERA_NIT -ErrorAction SilentlyContinue
  $databaseUrl = $null
  $jwtSecret = $null
  $secureDatabaseUrl.Dispose()
  $secureJwtSecret.Dispose()
}
