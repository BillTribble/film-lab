#!/bin/bash
# Double-click to run Film lab locally (macOS). Asks for a photo folder, then
# opens the app in your browser. Exports are saved to ~/Downloads.
# Leak scans: set FILM_LAB_LEAKS, or keep them in a "Light Leaks" folder in
# ~/Pictures or your Dropbox.
cd "$(dirname "$0")" || exit 1

FOLDER=$(osascript -e 'try' -e 'POSIX path of (choose folder with prompt "Choose a folder of photos (Cancel to import in the app)")' -e 'end try' 2>/dev/null)

LEAKS="$FILM_LAB_LEAKS"
for candidate in "$HOME/Pictures/Light Leaks" "$HOME/Library/CloudStorage/Dropbox/Light Leaks" "$HOME/Dropbox/Light Leaks"; do
  [ -z "$LEAKS" ] && [ -d "$candidate" ] && LEAKS="$candidate"
done

DUST="$FILM_LAB_DUST"
for candidate in "$HOME/Pictures/Film Dust" "$HOME/Library/CloudStorage/Dropbox/Film Dust" "$HOME/Dropbox/Film Dust"; do
  [ -z "$DUST" ] && [ -d "$candidate" ] && DUST="$candidate"
done

ARGS=()
[ -n "$FOLDER" ] && ARGS+=("$FOLDER")
[ -n "$LEAKS" ] && [ -d "$LEAKS" ] && ARGS+=(--leaks "$LEAKS")
[ -n "$DUST" ] && [ -d "$DUST" ] && ARGS+=(--dust "$DUST")

exec python3 server.py "${ARGS[@]}"
