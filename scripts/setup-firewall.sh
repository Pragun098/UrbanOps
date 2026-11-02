#!/usr/bin/env bash
# ==============================================================================
# UrbanOps - Production Host Firewall Configuration (UFW)
# ==============================================================================
# Usage:
#   sudo chmod +x scripts/setup-firewall.sh
#   sudo ./scripts/setup-firewall.sh
# ==============================================================================

set -euo pipefail

echo ">>> [UrbanOps] Starting Firewall (UFW) Setup..."

# Verify script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or with sudo." >&2
  exit 1
fi

# Ensure UFW is installed
if ! command -v ufw >/dev/null 2>&1; then
  echo "UFW not found. Installing ufw..."
  apt-get update && apt-get install -y ufw
fi

echo ">>> Setting default firewall policies..."
# Default deny all incoming connections, allow all outgoing
ufw default deny incoming
ufw default allow outgoing

echo ">>> Configuring standard service ports..."
# Allow SSH (Port 22) - prevent locking out administrative sessions
ufw allow 22/tcp comment 'UrbanOps: Allow SSH'

# Allow HTTP (Port 80) and HTTPS (Port 443) for web traffic / SSL cert renewal
ufw allow 80/tcp comment 'UrbanOps: Allow HTTP'
ufw allow 443/tcp comment 'UrbanOps: Allow HTTPS'

# Allow backend API port (Port 5000) if accessed directly through reverse proxy or public
# Uncomment if reverse proxy (e.g. Nginx) is not terminating on port 80/443:
# ufw allow 5000/tcp comment 'UrbanOps: Express API'

echo ">>> Configuring MongoDB (Port 27017) Access Rules..."
# Localhost loopback access for local backend server
ufw allow in on lo to any port 27017 proto tcp comment 'UrbanOps: MongoDB local loopback'

# Restrict remote access to MongoDB.
# To grant access to specific trusted backend / app server IPs, configure below:
TRUSTED_IPS=(
  "127.0.0.1"
  # "10.0.0.5"      # Example: Internal private subnet IP for secondary app server
  # "192.168.1.50"  # Example: Dedicated analytics / reporting node
)

for IP in "${TRUSTED_IPS[@]}"; do
  echo "Granting MongoDB (27017/tcp) access to trusted IP: ${IP}"
  ufw allow from "${IP}" to any port 27017 proto tcp comment "UrbanOps: MongoDB trusted IP ${IP}"
done

# Explicitly ensure MongoDB is blocked for all other incoming interfaces
# (ufw default deny incoming already enforces this, but logging/explicit drop helps audit)

echo ">>> Enabling UFW..."
# Force enable without interactive prompt confirmation
ufw --force enable

echo ">>> Firewall status:"
ufw status verbose

echo ">>> [UrbanOps] Firewall setup completed successfully."
