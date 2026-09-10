# Frapi AI 更新服务部署脚本
# 用法：在项目根目录执行 .\deploy.ps1
# 前提：已安装 Node.js + npx wrangler，已 wrangler login

param(
  [string]$ProjectName = "frapi-updates",
  [string]$DbName = "frapi-updates-db",
  [string]$BucketName = "frapi-updates-files"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Frapi AI 更新服务部署脚本" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 1. 检查 wrangler 是否可用
Write-Host "[1/6] 检查 wrangler CLI..." -ForegroundColor Yellow
$npxCheck = npx wrangler --version 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  wrangler 未安装，正在安装..." -ForegroundColor Yellow
  npm install -g wrangler
}
Write-Host "  OK: $npxCheck" -ForegroundColor Green

# 2. 创建 D1 数据库
Write-Host "`n[2/6] 创建 D1 数据库 ($DbName)..." -ForegroundColor Yellow
$d1Result = npx wrangler d1 create $DbName 2>&1
# 解析 database_id
$dbId = ""
foreach ($line in $d1Result -split "`n") {
  if ($line -match "database_id\s*=\s*['""']([^'""]+)['""']") {
    $dbId = $Matches[1]
    break
  }
  if ($line -match "database_id.*=\s*(\w+)") {
    $dbId = $Matches[1]
    break
  }
}
# 如果数据库已存在，wrangler 会报错，尝试从列表中获取
if (!$dbId) {
  Write-Host "  数据库可能已存在，从列表获取..." -ForegroundColor Yellow
  $d1List = npx wrangler d1 list 2>&1
  foreach ($line in $d1List -split "`n") {
    if ($line -match "^\|\s*$DbName\s*\|\s*([0-9a-f-]+)") {
      $dbId = $Matches[1].Trim()
      break
    }
  }
}
if (!$dbId) {
  Write-Host "  无法获取 database_id，请手动从 Cloudflare Dashboard 创建数据库并填入 wrangler.toml" -ForegroundColor Red
  Write-Host "  wrangler d1 create 的输出：" -ForegroundColor Gray
  Write-Host $d1Result -ForegroundColor Gray
  exit 1
}
Write-Host "  D1 database_id = $dbId" -ForegroundColor Green

# 3. 更新 wrangler.toml 中的 database_id
Write-Host "`n[3/6] 更新 wrangler.toml..." -ForegroundColor Yellow
$wranglerToml = Get-Content "wrangler.toml" -Raw
$wranglerToml = $wranglerToml -replace 'database_id = ""', "database_id = `"$dbId`""
Set-Content "wrangler.toml" $wranglerToml
Write-Host "  已写入 database_id" -ForegroundColor Green

# 4. 创建 R2 存储桶
Write-Host "`n[4/6] 创建 R2 存储桶 ($BucketName)..." -ForegroundColor Yellow
npx wrangler r2 bucket create $BucketName 2>&1 | Out-Null
Write-Host "  R2 存储桶已就绪（已存在则跳过）" -ForegroundColor Green

# 5. 初始化数据库
Write-Host "`n[5/6] 初始化 D1 数据库 schema..." -ForegroundColor Yellow
npx wrangler d1 execute $DbName --file=schema.sql --remote 2>&1
Write-Host "  数据库表已创建" -ForegroundColor Green

# 6. 部署到 Cloudflare Pages
Write-Host "`n[6/6] 部署到 Cloudflare Pages..." -ForegroundColor Yellow
npx wrangler pages deploy . --project-name $ProjectName
if ($LASTEXITCODE -ne 0) {
  Write-Host "  首次部署可能需要先创建项目，重试..." -ForegroundColor Yellow
  npx wrangler pages deploy . --project-name $ProjectName --commit-message "Initial deploy"
}
Write-Host "  部署完成!" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  部署完成!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "1. Cloudflare Dashboard -> Pages -> $ProjectName -> Custom Domains" -ForegroundColor White
Write-Host "   Bind domain (e.g. updates.frapi.kdns.fr)" -ForegroundColor White
Write-Host ""
Write-Host "2. tauri.conf.json endpoint already updated to:" -ForegroundColor White
Write-Host "   https://updates.frapi.kdns.fr/app-updates/{{target}}/{{arch}}/{{current_version}}" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Admin panel: https://your-domain/" -ForegroundColor White
Write-Host "   Default password: frapi-admin-2026 (change in Pages Env Vars)" -ForegroundColor Yellow
Write-Host ""
Write-Host "4. Create version -> upload installer + .sig -> set as latest" -ForegroundColor White
Write-Host ""
Write-Host "5. Build with signing:" -ForegroundColor White
Write-Host '   $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content E:\ChatX\agent-app\.tauri\appupdate.key -Raw)' -ForegroundColor Gray
Write-Host '   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-key-password"' -ForegroundColor Gray
Write-Host '   cd E:\ChatX\agent-app; npm run tauri build' -ForegroundColor Gray
Write-Host ""
