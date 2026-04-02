#!/bin/sh
set -e

# --- Configuration ---
GPG_AGENT_CONF="$HOME/.gnupg/gpg-agent.conf"
GPG_CONF="$HOME/.gnupg/gpg.conf"
DEFAULT_CACHE_TTL=86400
MAX_CACHE_TTL=86400

# --- Helpers ---
usage() {
  echo "Usage: $(basename "$0") <command>"
  echo ""
  echo "Commands:"
  echo "  --generate     Generate a new GPG key (interactive)"
  echo "  --test-sign    Test signing with a key (prompts for email)"
  echo "  --configure    Configure gpg-agent (cache TTL, pinentry)"
  exit 1
}

find_key_by_email() {
  email="$1"
  gpg --list-secret-keys --keyid-format long "$email" 2>/dev/null \
    | grep -m1 'sec' \
    | sed 's/.*\/\([A-F0-9]\{16\}\).*/\1/'
}

generate_key() {
  echo "GPG Key Generation"
  echo "==================="
  echo ""
  echo "When prompted, select:"
  echo "  Kind:    (1) RSA and RSA"
  echo "  Size:    4096"
  echo "  Expiry:  your choice (0 = no expiry)"
  echo ""

  gpg --full-generate-key

  echo ""
  echo "Your keys:"
  gpg --list-secret-keys --keyid-format long
}

test_sign() {
  printf "Email: "
  read -r email

  if [ -z "$email" ]; then
    echo "Error: email is required"
    exit 1
  fi

  key_id=$(find_key_by_email "$email")

  if [ -z "$key_id" ]; then
    echo "Error: no key found for $email"
    exit 1
  fi

  echo "Testing sign with key $key_id ($email)..."
  echo "banana" | gpg --local-user "$key_id" --clearsign > /dev/null 2>&1

  if [ $? -eq 0 ]; then
    echo "Signing works."
  else
    echo "Signing failed."
    exit 1
  fi
}

configure_agent() {
  echo "GPG Agent Configuration"
  echo "========================"
  echo ""

  mkdir -p "$HOME/.gnupg"
  chmod 700 "$HOME/.gnupg"

  # gpg-agent.conf
  cat > "$GPG_AGENT_CONF" <<EOF
default-cache-ttl $DEFAULT_CACHE_TTL
max-cache-ttl $MAX_CACHE_TTL
EOF

  # Detect pinentry
  if command -v pinentry-mac > /dev/null 2>&1; then
    echo "pinentry-program $(command -v pinentry-mac)" >> "$GPG_AGENT_CONF"
    echo "  pinentry: pinentry-mac"
  elif command -v pinentry-gnome3 > /dev/null 2>&1; then
    echo "pinentry-program $(command -v pinentry-gnome3)" >> "$GPG_AGENT_CONF"
    echo "  pinentry: pinentry-gnome3"
  else
    echo "  pinentry: default"
  fi

  echo "  cache TTL: ${DEFAULT_CACHE_TTL}s ($(( DEFAULT_CACHE_TTL / 3600 ))h)"
  echo "  config: $GPG_AGENT_CONF"
  echo ""

  # gpg.conf (no-tty for non-interactive use)
  if [ ! -f "$GPG_CONF" ] || ! grep -q "no-tty" "$GPG_CONF" 2>/dev/null; then
    echo "no-tty" >> "$GPG_CONF"
  fi

  # Reload agent
  gpg-connect-agent reloadagent /bye 2>/dev/null || true

  echo "Agent reloaded."
  echo ""
  echo "Add to your shell profile (.zshrc / .bashrc):"
  echo '  export GPG_TTY=$(tty)'
}

# --- Main ---
case "${1:-}" in
  --generate)   generate_key ;;
  --test-sign)  test_sign ;;
  --configure)  configure_agent ;;
  *)            usage ;;
esac
