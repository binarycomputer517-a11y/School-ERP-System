#!/bin/bash

# --- CONFIGURATION ---
SERVER_USER="root"
SERVER_IP="72.61.140.252"
REMOTE_ROOT="/var/www/html"
REMOTE_PUBLIC="$REMOTE_ROOT/public"

echo "🚀 Starting Student Portal Deployment..."

# 1. Sync Frontend Files (HTML)
# Transfers core HTML files to the public directory
echo "📦 Uploading HTML assets..."
scp ./public/*.html $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/

# 2. Sync Directories (CSS, JS, & Global Config)
# Ensures your latest branding and URL fixes are applied
echo "🎨 Updating Design and Logic (CSS/JS)..."
scp -r ./public/css ./public/js $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/

# 3. Update Backend Routes
# Synchronizes the Node.js API logic
echo "🔙 Syncing Backend Routes..."
scp -r ./routes $SERVER_USER@$SERVER_IP:$REMOTE_ROOT/

# 4. Server Restart via PM2
# Restarts the application to apply backend changes
echo "🔄 Restarting Server Services..."
ssh $SERVER_USER@$SERVER_IP "pm2 restart all || systemctl restart node-app"

# 5. Deployment Verification
if [ $? -eq 0 ]; then
    echo "--------------------------------------------------------"
    echo "✅ DEPLOYMENT SUCCESSFUL!"
    echo "The branding fixes and URL slashes have been applied."
    echo "🌐 View Live: https://portal.bcsm.org.in/login.html"
    echo "--------------------------------------------------------"
else
    echo "❌ DEPLOYMENT FAILED!"
    echo "Please check your SSH connection or server permissions."
fi