#!/bin/bash
# POC: Alternate buffer with history flushed to main buffer via sync block
#
# Concept:
#   - App runs in alternate buffer (full screen control, no reflow bleed)
#   - When a "history line" needs to be persisted, briefly exit to main buffer
#     inside a sync block, write the line, re-enter alternate buffer
#   - On exit, main buffer has all the history lines in scrollback

SYNC_START=$'\x1b[?2026h'
SYNC_END=$'\x1b[?2026l'
ALT_ENTER=$'\x1b[?1049h'
ALT_EXIT=$'\x1b[?1049l'
CLEAR=$'\x1b[2J\x1b[H'
SAVE_CURSOR=$'\x1b7'
RESTORE_CURSOR=$'\x1b8'

# Draw a fake "zone" at the bottom of the alternate buffer
draw_zone() {
    local rows cols
    rows=$(tput lines)
    cols=$(tput cols)
    # Move to bottom area
    printf '\x1b[%d;1H' "$((rows - 2))"
    printf '\x1b[2K\x1b[7m %-*s \x1b[0m\n' "$((cols - 2))" "Status: Zone is alive | Items: $1"
    printf '\x1b[2K> Enter text (or "quit"): '
}

# Write a history line to the MAIN buffer, inside a sync block
flush_to_main() {
    local line="$1"
    printf '%s' "$SYNC_START"       # freeze terminal output
    printf '%s' "$ALT_EXIT"         # back to main buffer
    printf '%s\n' "$line"           # write to main buffer (now in real scrollback)
    printf '%s' "$ALT_ENTER"        # re-enter alternate buffer (clears it)
    printf '%s' "$SYNC_END"         # unfreeze - user sees one atomic frame
}

# --- Main ---

echo "=== Alt Buffer POC ==="
echo "This line is in the MAIN buffer before we start."
echo "You should see it again when we exit."
echo ""
sleep 1

# Enter alternate buffer
printf '%s' "$ALT_ENTER"
printf '%s' "$CLEAR"

count=0
draw_zone "$count"

while true; do
    read -r input
    if [[ "$input" == "quit" ]]; then
        break
    fi

    count=$((count + 1))

    # Flush the input as a history line to the main buffer
    flush_to_main "[$(date +%H:%M:%S)] $input"

    # Redraw the zone (alternate buffer was cleared on re-enter)
    printf '%s' "$CLEAR"
    printf '\x1b[1;1H'
    printf 'Alternate buffer - type things, they go to main buffer scrollback\n'
    printf 'History lines written: %d\n' "$count"
    printf '\n'
    printf 'Try resizing the terminal - the zone redraws cleanly!\n'
    draw_zone "$count"
done

# Exit alternate buffer - main buffer restored with all history
printf '%s' "$ALT_EXIT"

echo ""
echo "=== Back in main buffer ==="
echo "Scroll up - your history lines should be there!"
