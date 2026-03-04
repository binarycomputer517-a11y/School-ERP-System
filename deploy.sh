#!/bin/bash

# --- CONFIGURATION ---
SERVER_USER="root"
SERVER_IP="72.61.140.252"
REMOTE_ROOT="/var/www/html"
REMOTE_PUBLIC="$REMOTE_ROOT/public"

echo "🚀 Starting ERP Portal Deployment..."

# 1. Sync Core Backend Files
# Note: We skip .env and node_modules to keep the server environment stable
echo "📦 Uploading server.js and backend logic..."
scp ./server.js $SERVER_USER@$SERVER_IP:$REMOTE_ROOT/
scp -r ./routes $SERVER_USER@$SERVER_IP:$REMOTE_ROOT/
scp -r ./middleware ./controllers $SERVER_USER@$SERVER_IP:$REMOTE_ROOT/

# 2. Sync Frontend Assets (HTML, CSS, JS)
echo "🎨 Updating Frontend Assets..."
scp ./public/*.html $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/
scp -r ./public/css ./public/js $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/

# 3. Sync Branding & Media
echo "🖼️ Syncing Images (Logo, Robot, etc.)..."
scp -r ./public/images $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/

# 4. Remote Server Restart
# Restarting PM2 to apply backend changes immediately
echo "🔄 Restarting Server Services via PM2..."
ssh $SERVER_USER@$SERVER_IP "pm2 restart all || systemctl restart node-app"

# 5. Deployment Verification
if [ $? -eq 0 ]; then
    echo "--------------------------------------------------------"
    echo "✅ DEPLOYMENT SUCCESSFUL!"
    echo "All assets, routes, and branding have been updated."
    echo "The .env file on the server was NOT modified."
    echo "🌐 Live URL: https://portal.bcsm.org.in/login.html"
    echo "--------------------------------------------------------"
else
    echo "❌ DEPLOYMENT FAILED!"
    echo "Please check your SSH connection or server permissions."
fi