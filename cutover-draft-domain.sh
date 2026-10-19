#!/usr/bin/env bash
# Point 2027majordraft.crushworldseries.com at the league app (port 3040),
# which opens straight into the 2027 Majors draft room (DRAFT_HOSTS in .env),
# then stop the old stand-alone draft board so nobody edits stale data.
# Run with: sudo bash /home/greg/apps/se-league/cutover-draft-domain.sh
# Undo: sudo sed -i 's#127.0.0.1:3040#127.0.0.1:3030#g' /etc/nginx/sites-available/se-draft-board && sudo systemctl reload nginx
#       and: systemctl --user enable --now se-draft-board
set -euo pipefail
SITE=/etc/nginx/sites-available/se-draft-board

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root: sudo bash $0" >&2
  exit 1
fi

echo "==> Backing up $SITE"
cp "$SITE" "$SITE.bak-$(date +%Y%m%d%H%M%S)"

echo "==> Proxying to the league app on 3040"
sed -i 's#127.0.0.1:3030#127.0.0.1:3040#g' "$SITE"
grep -n proxy_pass "$SITE"

echo "==> Testing config"
nginx -t

echo "==> Reloading nginx"
systemctl reload nginx

echo "==> Stopping the old stand-alone draft board"
sudo -u greg XDG_RUNTIME_DIR=/run/user/$(id -u greg) systemctl --user disable --now se-draft-board

echo
echo "Done. Verify: curl -s https://2027majordraft.crushworldseries.com/api/home   (should name draft 2027-majors)"
