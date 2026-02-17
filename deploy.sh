#!/bin/bash

# --- CONFIGURATION ---
SERVER_USER="root"
SERVER_IP="72.61.140.252"
REMOTE_ROOT="/var/www/html"
REMOTE_PUBLIC="$REMOTE_ROOT/public"

echo "🚀 Starting Student Portal Deployment..."

# 1. Sync Frontend Files (HTML)
echo "📦 Uploading HTML assets..."
scp ./public/*.html $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/

# 2. Sync Directories (CSS, JS, & Global Config)
echo "🎨 Updating Design and Logic (CSS/JS)..."
scp -r ./public/css ./public/js $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/

# --- নতুন অংশ: ইমেজ আপলোড ---
# এটি আপনার লোকাল images ফোল্ডারকে সার্ভারের public/images ফোল্ডারে পাঠাবে
echo "🖼️ Syncing Images (Robot & Logo)..."
scp -r ./public/images $SERVER_USER@$SERVER_IP:$REMOTE_PUBLIC/
# -----------------------------

# 3. Update Backend Routes
echo "🔙 Syncing Backend Routes..."
scp -r ./routes $SERVER_USER@$SERVER_IP:$REMOTE_ROOT/

# 4. Server Restart via PM2
echo "🔄 Restarting Server Services..."
ssh $SERVER_USER@$SERVER_IP "pm2 restart all || systemctl restart node-app"

# 5. Deployment Verification
if [ $? -eq 0 ]; then
    echo "--------------------------------------------------------"
    echo "✅ DEPLOYMENT SUCCESSFUL!"
    echo "Images and Branding have been updated."
    echo "🌐 View Live: https://portal.bcsm.org.in/login.html"
    echo "--------------------------------------------------------"
else
    echo "❌ DEPLOYMENT FAILED!"
fi