param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
$commit = (& git -c "safe.directory=$projectRoot" -C $projectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read Git revision' }
$changes = & git -c "safe.directory=$projectRoot" -C $projectRoot status --porcelain
if ($changes) { throw 'Commit the source, documentation and screenshots before packaging.' }
$remoteLine = & git -c "safe.directory=$projectRoot" -C $projectRoot -c credential.interactive=never ls-remote origin refs/heads/main
if ($LASTEXITCODE -ne 0 -or ($remoteLine -split '\s+')[0] -ne $commit) { throw 'Push this commit to origin/main before packaging.' }
if (-not $OutputDirectory) {
  $stamp = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time').ToString('yyyyMMdd-HHmmss')
  $OutputDirectory = Join-Path $projectRoot "release/FloraGrid-$version-$stamp"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw "Output directory already exists: $OutputDirectory" }
Push-Location -LiteralPath $projectRoot
try {
  & npm.cmd run build -- --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed' }
  $binary = Join-Path $projectRoot 'src-tauri/target/release/desktop-calendar.exe'
  $bundle = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src-tauri/target/release/bundle/nsis') -Filter '*-setup.exe' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $bundle -or -not (Test-Path -LiteralPath $binary)) { throw 'Missing installer or release executable' }
  New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
  $installer = Join-Path $OutputDirectory "FloraGrid_${version}_x64-setup.exe"
  Copy-Item -LiteralPath $bundle.FullName -Destination $installer
  $portable = Join-Path $OutputDirectory 'FloraGrid'
  New-Item -ItemType Directory -Path $portable | Out-Null
  Copy-Item -LiteralPath $binary -Destination (Join-Path $portable 'FloraGrid.exe')
  @"
日枝 FloraGrid $version · Windows x64 免安装版

解压整个文件夹，双击 FloraGrid.exe 启动。
需要 Microsoft Edge WebView2 运行时；缺少时请从微软官网安装：
https://developer.microsoft.com/microsoft-edge/webview2/

免安装表示无需运行 Setup。数据默认保存在当前 Windows 用户的数据目录，
不会自动放在程序旁边；可以在“设置 → 数据”更换位置或导入、导出备份。
复制程序文件夹不等于备份日程。安装版与免安装版默认使用同一份用户数据。

源码：https://github.com/YawningPants/FloraGrid
版本提交：$commit
"@ | Set-Content -LiteralPath (Join-Path $portable 'README.txt') -Encoding UTF8
  $archive = Join-Path $OutputDirectory "FloraGrid_${version}_windows-x64_portable.zip"
  Compress-Archive -LiteralPath $portable -DestinationPath $archive -CompressionLevel Optimal
  $hashes = @($installer, $archive) | ForEach-Object {
    $filePath = $_
    $stream = [IO.File]::OpenRead($filePath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
    "$digest  $([IO.Path]::GetFileName($filePath))"
  }
  $hashes | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ASCII
  @{ version=$version; commit=$commit; repository='https://github.com/YawningPants/FloraGrid'; architecture='x64'; builtAt=[DateTime]::UtcNow.ToString('o'); installer=[IO.Path]::GetFileName($installer); portable=[IO.Path]::GetFileName($archive) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'release.json') -Encoding UTF8
  Write-Output "Release artifacts: $OutputDirectory"
} finally { Pop-Location }
