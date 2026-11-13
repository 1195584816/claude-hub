# Claude Code Stop hook(同步): 抓任务内容 -> 追加记录 -> 外部转发 -> 重生成面板 -> 提示音 -> 派生打标进程
# 注意:真实载荷 ConvertFrom-Json 会失败(PS5.1挑食),字段一律用正则抽取
$ErrorActionPreference = 'SilentlyContinue'
# 路径全部相对用户主目录推导,换任何一台机器都能直接用
$hooksDir = Join-Path $env:USERPROFILE '.claude\hooks'
$hubDir   = Join-Path $env:USERPROFILE '.claude-hub'
if (-not (Test-Path $hooksDir)) { New-Item -ItemType Directory -Force $hooksDir | Out-Null }
if (-not (Test-Path $hubDir))   { New-Item -ItemType Directory -Force $hubDir   | Out-Null }
$feed  = Join-Path $hooksDir 'done-feed.jsonl'
$panel = Join-Path $hubDir '任务完成面板.html'
$nlog  = Join-Path $hooksDir 'notify.log'
function NLog($m) { try { Add-Content -Path $nlog -Value ("{0} {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch {} }

$raw = ''
# 必须按 UTF-8 字节读 stdin:走 [Console]::In 会用系统 GBK 解码,中文目录名/内容全乱码
try {
  $si = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 65536
  while (($n = $si.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
  $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
  $ms.Dispose()
} catch { try { $raw = [Console]::In.ReadToEnd() } catch {} }
$proj = 'Claude'; $task = ''; $result = ''; $sid = ''; $tp = ''; $cwdV = ''; $tokSum = 0
try {
  if ($raw) {
    $mm = [regex]::Match($raw, '"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($mm.Success) { $cwdV = $mm.Groups[1].Value.Replace('\/', '/').Replace('\\', '\'); $proj = Split-Path $cwdV -Leaf }
    elseif ($env:CLAUDE_PROJECT_DIR) { $cwdV = $env:CLAUDE_PROJECT_DIR; $proj = Split-Path $cwdV -Leaf }
    $mm = [regex]::Match($raw, '"session_id"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($mm.Success) { $sid = $mm.Groups[1].Value }
    $mm = [regex]::Match($raw, '"transcript_path"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($mm.Success) { $tp = $mm.Groups[1].Value.Replace('\/', '/').Replace('\\', '\') }
    # 只读转录尾部(最多5MB),倒扫抓最后一条真人指令 + 最后一段回复
    if ($tp -and (Test-Path $tp)) {
      $fs = [System.IO.File]::Open($tp, 'Open', 'Read', 'ReadWrite')
      $take = [Math]::Min($fs.Length, 5MB)
      $null = $fs.Seek(-$take, 'End')
      $buf = New-Object byte[] $take
      $null = $fs.Read($buf, 0, $take)
      $fs.Close()
      $lines = [System.Text.Encoding]::UTF8.GetString($buf) -split "`n"
      for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $e = $null
        try { $e = $lines[$i] | ConvertFrom-Json } catch { continue }
        if (-not $e) { continue }
        if ($e.isSidechain -or $e.isMeta -or $e.isCompactSummary) { continue }
        if ($e.type -eq 'assistant') {
          if ($tokSum -eq 0 -and $e.message.usage) {
            $u = $e.message.usage
            $tokSum = [int]$u.input_tokens + [int]$u.cache_creation_input_tokens + [int]$u.output_tokens
          }
          if (-not $result) {
            $t = (@($e.message.content) | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' '
            $t = ($t -replace '\s+', ' ').Trim()
            if ($t) { $result = $t }
          }
          continue
        }
        if ($e.type -ne 'user') { continue }
        $c = $e.message.content
        $t = ''
        if ($c -is [string]) { $t = $c }
        elseif ($c) { $t = (@($c) | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' ' }
        $t = $t -replace '(?s)<local-command-caveat>.*?</local-command-caveat>', ' '
        $t = $t -replace '(?s)<command-name>.*?</command-name>', ' '
        $t = $t -replace '(?s)<command-message>.*?</command-message>', ' '
        $t = $t -replace '(?s)<command-args>.*?</command-args>', ' '
        $t = $t -replace '(?s)<local-command-stdout>.*?</local-command-stdout>', ' '
        $t = $t -replace '(?s)<system-reminder>.*?</system-reminder>', ' '
        $t = ($t -replace '\s+', ' ').Trim()
        if (-not $t) { continue }
        if ($t -match '^<') { continue }
        $task = $t
        break
      }
    }
  }
} catch {}
if ($task.Length -gt 120) { $task = $task.Substring(0, 120) + '…' }
if ($result.Length -gt 200) { $result = $result.Substring(0, 200) + '…' }
NLog ("rawlen=" + $raw.Length + " proj=" + $proj + " sid=" + $sid.Substring(0, [Math]::Min(8, $sid.Length)) + " taskfound=" + [bool]$task)
if ($proj -eq 'Claude' -and $raw) { NLog ("raw head: " + ($raw.Substring(0, [Math]::Min(200, $raw.Length)) -replace '\s+', ' ')) }

# 1) 追加完成记录(JSONL,保留最近100条)
try {
  $rec = @{ ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); proj = $proj; task = $task; result = $result; sid = $sid; cwd = $cwdV; tok = $tokSum } | ConvertTo-Json -Compress
  [System.IO.File]::AppendAllText($feed, $rec + "`n", (New-Object System.Text.UTF8Encoding $false))
  $fl = [System.IO.File]::ReadAllLines($feed)
  if ($fl.Count -gt 100) {
    [System.IO.File]::WriteAllLines($feed, $fl[($fl.Count - 100)..($fl.Count - 1)], (New-Object System.Text.UTF8Encoding $false))
  }
} catch {}

# 1.5) 外部通知转发:企微/飞书/Server酱(在 claude-hub 客户端 ⚙️ 里配置,未启用则跳过)
try {
  # 配置可能在 Electron 用户数据目录或 ~/.claude-hub,挨个找
  $ncfg = @(
    (Join-Path $env:APPDATA 'ClaudeHub\notify-config.json'),
    (Join-Path $env:APPDATA 'claude-hub\notify-config.json'),
    (Join-Path $hubDir 'notify-config.json')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  $fwd = Join-Path $hooksDir 'notify-forward.js'
  if ($ncfg -and (Test-Path $fwd) -and ((Get-Content -Raw $ncfg) -match '"enabled":\s*true')) {
    $tmpn = Join-Path $env:TEMP ('claude-notify-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($tmpn, $rec, (New-Object System.Text.UTF8Encoding $false))
    Start-Process -FilePath 'node' -ArgumentList @($fwd, '--file', $tmpn, '--config', $ncfg) -WindowStyle Hidden
  }
} catch {}

# 2) 重生成面板网页(最新在上,自动刷新,每条带跳转链接)
try {
  $enc = { param($s) [System.Net.WebUtility]::HtmlEncode($s) }
  $rows = ''
  $all = @([System.IO.File]::ReadAllLines($feed))
  [array]::Reverse($all)
  $shown = 0
  foreach ($ln in $all) {
    if ($shown -ge 30) { break }
    $r = $null
    try { $r = $ln | ConvertFrom-Json } catch { continue }
    if (-not $r) { continue }
    $fresh = ''
    try {
      $age = (Get-Date) - [datetime]::ParseExact($r.ts, 'yyyy-MM-dd HH:mm:ss', $null)
      if ($age.TotalMinutes -lt 3) { $fresh = ' fresh' }
    } catch {}
    $pj = & $enc $r.proj
    $tk = & $enc $r.task
    $rs = & $enc $r.result
    $pu = [Uri]::EscapeDataString($r.proj)
    if (-not $tk) { $tk = '(未捕获到指令)' }
    $resLine = ''
    if ($rs) { $resLine = "<div class='result'>答复:$rs</div>" }
    $rows += "<div class='card$fresh'><div class='top'><span class='proj'>$pj</span><span class='time'>$($r.ts)</span><a class='jump' href='claude-jump://$pu'>↗ 跳转</a></div><div class='task'>指令:$tk</div>$resLine</div>"
    $shown++
  }
  $now = Get-Date -Format 'HH:mm:ss'
  $html = @"
<!doctype html>
<html lang='zh'>
<head>
<meta charset='utf-8'>
<title>任务完成面板 · Claude</title>
<style>
body { background:#0f1220; color:#e6e8f0; font-family:'Microsoft YaHei',sans-serif; margin:0; padding:24px; }
h1 { font-size:18px; margin:0 0 4px; }
.sub { color:#8a90a8; font-size:12px; margin-bottom:16px; }
.card { background:#181c30; border-radius:10px; padding:12px 16px; margin-bottom:10px; border-left:4px solid #2a3050; }
.card.fresh { border-left-color:#34d399; box-shadow:0 0 12px rgba(52,211,153,.25); }
.top { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
.proj { color:#34d399; font-weight:bold; }
.time { color:#8a90a8; font-size:12px; }
.jump { margin-left:auto; color:#0f1220; background:#34d399; text-decoration:none; font-size:12px; padding:3px 10px; border-radius:99px; font-weight:bold; }
.jump:hover { background:#6ee7b7; }
.task { font-size:14px; }
.result { color:#9aa3c0; font-size:13px; margin-top:4px; }
</style>
</head>
<body>
<h1>✅ 任务完成面板</h1>
<div class='sub'>最近更新 $now · 每4秒自动刷新 · 点「↗ 跳转」直达终端会话(首次会弹协议确认,勾"始终允许")</div>
$rows
<script>setTimeout(function(){location.reload();},4000);</script>
</body>
</html>
"@
  [System.IO.File]::WriteAllText($panel, $html, (New-Object System.Text.UTF8Encoding $false))
} catch {}

# 3) 提示音双保险:wav + 系统蜂鸣
try {
  $wav = @('C:\Windows\Media\Windows Notify System Generic.wav',
           'C:\Windows\Media\Windows Notify.wav',
           'C:\Windows\Media\notify.wav') | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($wav) { (New-Object System.Media.SoundPlayer $wav).PlaySync() }
} catch {}
try { [console]::beep(1200, 180); [console]::beep(1600, 220) } catch {}

# 4) 派生同控制台的后台小进程,延迟4秒把标签页标题打成 ✅ 项目名
try {
  Start-Process -FilePath 'powershell.exe' -NoNewWindow -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $hooksDir 'claude-title-stamp.ps1'), "`"$proj`"")
} catch {}

exit 0
