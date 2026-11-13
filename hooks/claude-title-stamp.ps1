# 延迟打标:等 Claude 停止刷新标题后,把本标签页标题改成 ✅ 项目名
param([string]$Proj = 'Claude')
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds 4
try { [Console]::Title = ('✅ ' + $Proj.Trim('"')) } catch {}
exit 0
