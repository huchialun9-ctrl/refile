# Deploy to Cloudflare Pages
# Usage: $env:CLOUDFLARE_API_TOKEN="your_token"; .\deploy-cloudflare.ps1

$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token) {
    Write-Error "Set CLOUDFLARE_API_TOKEN environment variable first"
    exit 1
}

npx wrangler pages deploy dist --project-name refile --branch master
