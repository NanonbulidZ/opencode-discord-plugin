param([switch]$NoLaunch)

Write-Host "=== Opencode Discord Plugin Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check for opencode
$opencodeCmd = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencodeCmd) {
    Write-Host "Installing opencode..." -ForegroundColor Yellow
    npm install -g opencode-ai
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install opencode. Install it manually: npm install -g opencode-ai" -ForegroundColor Red
        exit 1
    }
}

# Secure token input
Write-Host "Enter your Discord Bot Token (typing will be hidden):" -ForegroundColor Yellow
$secureToken = Read-Host -AsSecureString
$tokenPtr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "No token entered. Aborting." -ForegroundColor Red
    exit 1
}

# Write .env file (gitignored)
@"
DISCORD_BOT_TOKEN=$token
"@ | Set-Content -Path ".env" -NoNewline

Write-Host ""
Write-Host "Token saved to .env file (this file is gitignored)." -ForegroundColor Green

# Clear token from memory
$token = $null
[GC]::Collect()

Write-Host ""
Write-Host "Discord Developer Portal setup required:" -ForegroundColor Cyan
Write-Host "  1. Go to https://discord.com/developers/applications" -ForegroundColor White
Write-Host "  2. Create or select your application" -ForegroundColor White
Write-Host "  3. Go to Bot > Reset Token -> copy it (you just entered it above)" -ForegroundColor White
Write-Host "  4. Under Privileged Gateway Intents, ENABLE:" -ForegroundColor White
Write-Host "     - Message Content Intent (required)" -ForegroundColor Green
Write-Host "     - Server Members Intent (optional)" -ForegroundColor DarkYellow
Write-Host "  5. Go to OAuth2 > URL Generator" -ForegroundColor White
Write-Host "     - Scopes: bot" -ForegroundColor White
Write-Host "     - Permissions: Send Messages, Read Messages/View Channels, Read Message History" -ForegroundColor White
Write-Host "  6. Use the generated URL to invite the bot to a server" -ForegroundColor White
Write-Host "  7. DM the bot after it joins -> it replies via DMs" -ForegroundColor White
Write-Host ""

if (-not $NoLaunch) {
    Write-Host "Launching opencode..." -ForegroundColor Yellow
    $env:DISCORD_BOT_TOKEN = $token
    opencode
} else {
    Write-Host "Run this to start opencode with the bot:" -ForegroundColor Yellow
    Write-Host "  `$env:DISCORD_BOT_TOKEN = (Get-Content .env | Select-String '^DISCORD_BOT_TOKEN=(.+)$').Matches.Groups[1].Value" -ForegroundColor Green
    Write-Host "  opencode" -ForegroundColor Green
}
