# Publica o Decupagem no formato esperado pelo Hub Pedro.
# Exemplo: .\publicar.ps1 -Versao v0.2.2 -Enviar
param(
  [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Versao,
  [string]$PastaBuild = '',
  [switch]$Enviar,
  [string]$RepoReleases = 'pedeosimm-creator/decupagem',
  [int]$Manter = 3
)

$ErrorActionPreference = 'Stop'
$raiz = $PSScriptRoot
$zip = Join-Path $raiz 'dist\decupagem.zip'
$versaoPacote = $Versao.Substring(1)
$versaoCodigo = (Get-Content (Join-Path $raiz 'package.json') -Raw | ConvertFrom-Json).version
if ($versaoCodigo -ne $versaoPacote) { throw "package.json está em $versaoCodigo; esperado $versaoPacote" }
if ($Manter -lt 3) { throw 'Manter deve ser pelo menos 3 para conservar histórico de recuperação.' }

if (-not $PastaBuild) {
  Push-Location $raiz
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou' }
    $bash = (Get-Command bash -ErrorAction SilentlyContinue).Source
    if (-not $bash -and (Test-Path 'C:\Program Files\Git\bin\bash.exe')) { $bash = 'C:\Program Files\Git\bin\bash.exe' }
    if (-not $bash) { throw 'Git Bash não encontrado; instale Git for Windows ou passe -PastaBuild com um build pronto.' }
    & $bash 'scripts/build-dist.sh'
    if ($LASTEXITCODE -ne 0) { throw 'build-dist.sh falhou' }
  } finally { Pop-Location }
  $PastaBuild = Join-Path $raiz 'dist\decupagem-win32-x64'
}

$PastaBuild = [IO.Path]::GetFullPath($PastaBuild)
foreach ($required in @('decupagem.exe', 'resources\app\main.js', 'resources\app\src\index.html', 'resources\app\node_modules')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PastaBuild $required))) { throw "Build incompleto: $required" }
}
$suspeitos = @(Get-ChildItem -LiteralPath $PastaBuild -Recurse -File | Where-Object { $_.Name -match '^(\.env(\..*)?|.*\.(pfx|pem|key|p12))$' })
if ($suspeitos.Count) { throw "Possíveis segredos no pacote: $($suspeitos.FullName -join ', ')" }

# ZipArchive grava '/' nos nomes das entradas. Compress-Archive no Windows pode
# gravar '\', que outros extratores interpretam como parte do nome do arquivo.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zip, [IO.FileMode]::Create)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $PastaBuild -Recurse -File) {
      $relative = $file.FullName.Substring($PastaBuild.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
      if ($relative -eq 'versao.txt') { continue }
      $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
      $inputFile = $file.OpenRead()
      $outputFile = $entry.Open()
      try { $inputFile.CopyTo($outputFile) }
      finally { $outputFile.Dispose(); $inputFile.Dispose() }
    }
    $versionEntry = $archive.CreateEntry('versao.txt')
    $writer = [IO.StreamWriter]::new($versionEntry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write($Versao) } finally { $writer.Dispose() }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

$check = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = @($check.Entries.FullName)
  foreach ($required in @('decupagem.exe', 'versao.txt', 'resources/app/main.js', 'resources/app/src/index.html')) {
    if ($required -notin $names) { throw "ZIP incompleto: $required" }
  }
  if (@($names | Where-Object { $_ -match '\\' }).Count) { throw 'ZIP contém entradas com barra invertida' }
  $reader = [IO.StreamReader]::new($check.GetEntry('versao.txt').Open())
  try { if ($reader.ReadToEnd() -ne $Versao) { throw 'versao.txt não corresponde à tag' } }
  finally { $reader.Dispose() }
} finally { $check.Dispose() }
Write-Host ('Pacote pronto: {0} ({1:N1} MB)' -f $zip, ((Get-Item $zip).Length / 1MB))
if (-not $Enviar) { return }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI não encontrado.' }
$repoInfo = gh repo view $RepoReleases --json visibility,defaultBranchRef | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $repoInfo.visibility -ne 'PUBLIC') { throw "Repo de releases precisa ser público: $RepoReleases" }
$existingRaw = gh release view $Versao -R $RepoReleases --json isDraft 2>$null
if ($LASTEXITCODE -eq 0) {
  $existing = $existingRaw | ConvertFrom-Json
  if (-not $existing.isDraft) { throw "Release $Versao já está publicada em $RepoReleases" }
} else {
  gh release create $Versao -R $RepoReleases --target $repoInfo.defaultBranchRef.name --title "Decupagem $Versao" --notes "Decupagem $Versao. Atualize pelo Hub Pedro." --draft
  if ($LASTEXITCODE -ne 0) { throw 'Não consegui criar o rascunho da release' }
}
gh release upload $Versao "$zip#decupagem.zip" -R $RepoReleases --clobber
if ($LASTEXITCODE -ne 0) { throw 'Upload falhou; a release ficou em rascunho para tentar novamente.' }
$assets = @(gh release view $Versao -R $RepoReleases --json assets --jq '.assets[].name')
if ($assets -notcontains 'decupagem.zip') { throw 'Release sem decupagem.zip; o rascunho não foi publicado.' }
gh release edit $Versao -R $RepoReleases --draft=false
if ($LASTEXITCODE -ne 0) { throw 'Não consegui publicar o rascunho.' }
Write-Host "Publicado: https://github.com/$RepoReleases/releases/tag/$Versao"

# O protocolo conserva as três releases mais recentes para permitir retorno.
$tags = @(gh release list -R $RepoReleases --limit 100 --json tagName --jq '.[].tagName')
if ($LASTEXITCODE -ne 0) { throw 'Release publicada, mas não consegui listar versões antigas.' }
foreach ($tag in ($tags | Select-Object -Skip $Manter)) {
  gh release delete $tag -R $RepoReleases --yes --cleanup-tag
  if ($LASTEXITCODE -ne 0) { throw "Release publicada, mas não consegui remover $tag" }
}
