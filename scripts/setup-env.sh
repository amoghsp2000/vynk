#!/usr/bin/env sh
# Creates .env from .env.example with freshly generated secrets.
# Safe to re-run: an existing .env is never overwritten.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists — leaving it untouched."
  exit 0
fi

rand() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

cp .env.example .env
sed -i.bak \
  -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(rand)|" \
  -e "s|^OTP_HMAC_SECRET=.*|OTP_HMAC_SECRET=$(rand)|" \
  -e "s|^TURN_SECRET=.*|TURN_SECRET=$(rand)|" \
  .env
rm -f .env.bak

if [ -d server/node_modules/web-push ]; then
  keys=$(cd server && node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
  pub=${keys% *}; priv=${keys#* }
  sed -i.bak -e "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$pub|" -e "s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=$priv|" .env
  rm -f .env.bak
  echo "Generated VAPID keys for Web Push."
else
  echo "server/node_modules missing: VAPID keys not generated (push will use the log-only provider)."
  echo "Run 'cd server && npm install && npm run vapid' and paste the keys into .env to enable Web Push."
fi
echo "Wrote .env with generated secrets."
