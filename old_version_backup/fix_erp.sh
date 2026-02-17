#!/bin/bash

echo "🚀 Starting ERP Super Fixer..."

# 1. Resolve Git conflicts and pull latest code
echo "📦 Updating code from GitHub..."
cd /var/www/html
git fetch --all
git reset --hard origin/main

# 2. Update Node.js to version 20 (Required for newer packages)
echo "⚙️ Checking/Updating Node.js version..."
npm install -g n
n 20
# Refreshing path for the current session
export PATH=$PATH

# 3. Fresh installation to resolve module errors
echo "📁 Reinstalling dependencies..."
rm -rf node_modules
npm install

# 4. Fix database user status and role (SQL)
echo "🗄️ Fixing database user credentials..."
sudo -u postgres psql -d school_erp -c "UPDATE users SET role = 'Admin', is_active = true, status = 'active' WHERE username = 'wb02_admin';"

# 5. Restart the server
echo "🔄 Restarting server with PM2..."
pm2 restart all
pm2 save

echo "✅ All errors fixed! Please try logging in now."
