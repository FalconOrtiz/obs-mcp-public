# Loads User-scope env vars into this process and starts the read-only X live feed.
# Values are never printed: only the names and whether each is set.
$ErrorActionPreference = 'Stop'
$names = @('OBS_WS_PASSWORD', 'OBS_STREAM_KEY', 'OBS_STREAM_SERVER', 'X_USER_ACCESS_TOKEN', 'X_BEARER_TOKEN', 'X_USER_ID', 'X_STREAM_CREDIT_CAP_USD', 'X_BROADCAST_ID', 'X_LIVE_CHAT', 'X_SECONDARY_SOURCES', 'X_BOT_TOKEN', 'X_CHAT_WRITE', 'X_CLIENT_SECRET', 'X_CONSUMER_SECRET', 'X_WEBHOOK_HOST', 'X_WEBHOOK_PORT', 'X_WEBHOOK_PATH', 'X_READ_MODE', 'X_AGENT_INPUT', 'X_REPLY_WRITE', 'X_REPLY_AS', 'X_BOT_USER_ACCESS_TOKEN', 'X_STATE_FILE')
$names += [Environment]::GetEnvironmentVariables('User').Keys | Where-Object { $_ -like 'X_*' }
foreach ($name in ($names | Sort-Object -Unique)) {
  $value = [Environment]::GetEnvironmentVariable($name, 'User')
  if ([string]::IsNullOrEmpty($value)) {
    Write-Host "$name : not set"
  } else {
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    Write-Host "$name : set"
  }
  Remove-Variable value -ErrorAction SilentlyContinue
}
if ([string]::IsNullOrEmpty($env:X_STREAM_CREDIT_CAP_USD)) {
  Write-Host 'X_STREAM_CREDIT_CAP_USD is not set. Refusing to start X live polling.'
  exit 1
}
foreach ($required in @('X_USER_ACCESS_TOKEN', 'X_USER_ID')) {
  if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($required, 'Process'))) {
    Write-Host "$required is not set. Set it in User scope and run again."
    exit 1
  }
}
$root = Split-Path -Parent $PSScriptRoot
& node --experimental-strip-types (Join-Path $root 'scripts/x-live.ts')
exit $LASTEXITCODE
