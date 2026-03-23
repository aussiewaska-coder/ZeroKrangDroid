#!/data/data/com.termux/files/usr/bin/bash
# Run this ONCE on the phone to install all widget shortcuts
# Usage: bash ~/ZeroKrangDroid/termux-shortcuts/setup.sh

echo "Installing ZeroKrang Termux shortcuts..."

SHORTCUTS=~/.shortcuts
mkdir -p "$SHORTCUTS"

# Copy all scripts (excluding this setup file)
for f in ~/ZeroKrangDroid/termux-shortcuts/*; do
  name=$(basename "$f")
  [ "$name" = "setup.sh" ] && continue
  cp "$f" "$SHORTCUTS/$name"
  chmod +x "$SHORTCUTS/$name"
  echo "  ✓ $name"
done

echo ""
echo "Done. Long-press your homescreen → Widgets → Termux:Widget"
echo "Add each button. Then tap to use."
echo ""
echo "Also make sure git is configured:"
echo "  git config --global credential.helper store"
echo "  cd ~/ZeroKrangDroid && git pull  (enter token once, it'll be saved)"
