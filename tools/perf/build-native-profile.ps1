param([switch]$DataTransfer)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$profileRoot = Join-Path $projectRoot 'src-tauri/target/native-perf'
New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
$profileId = 'com.rizhi.perf' + ([guid]::NewGuid().ToString('N').Substring(0,12))
$configPath = Join-Path $profileRoot 'tauri.perf.conf.json'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$listener.Start()
$debugPort = $listener.LocalEndpoint.Port
$listener.Stop()
$config = @{
  identifier = $profileId
  productName = '日枝性能样本'
  app = @{ windows = @(@{ label='main'; title='日枝性能样本'; width=390; height=900; minWidth=320; minHeight=640; visible=$false; transparent=$true; decorations=$false; resizable=$true; maximizable=$false; backgroundColor='#00000000'; additionalBrowserArgs="--remote-debugging-port=$debugPort --disable-background-networking" }) }
}
if ($DataTransfer) {
  foreach ($entry in @(@{label='month-view';url='index.html#month';width=1180;height=820},@{label='settings';url='index.html#settings?tab=data';width=780;height=560})) {
    $config.app.windows += @{label=$entry.label;url=$entry.url;title='日枝隔离数据测试';width=$entry.width;height=$entry.height;visible=$false;decorations=$false;additionalBrowserArgs="--remote-debugging-port=$debugPort --disable-background-networking"}
  }
}
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8
$releaseExe = Join-Path $projectRoot 'src-tauri/target/release/desktop-calendar.exe'
$backupExe = Join-Path $profileRoot 'original-release.exe'
$hadOriginal = Test-Path -LiteralPath $releaseExe
if ($hadOriginal) { Copy-Item -LiteralPath $releaseExe -Destination $backupExe -Force }
try {
  Push-Location -LiteralPath $projectRoot
  try {
    & npm.cmd run build -- --no-bundle --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'Isolated native performance build failed' }
  } finally { Pop-Location }
  $sampleExe = Join-Path $profileRoot 'rizhi-perf.exe'
  Copy-Item -LiteralPath $releaseExe -Destination $sampleExe -Force
  @{ identifier=$profileId; exe=$sampleExe; port=$debugPort; data=(Join-Path $profileRoot 'calendar-data') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $profileRoot 'manifest.json') -Encoding utf8
} finally {
  if ($hadOriginal) { Copy-Item -LiteralPath $backupExe -Destination $releaseExe -Force }
}
