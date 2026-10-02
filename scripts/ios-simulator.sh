#!/usr/bin/env bash
#
# iOS Simulator helper script for QuickScan PWA testing
#
# Usage:
#   ./scripts/ios-simulator.sh                           # Default: iPhone 17 Pro, localhost:3000
#   ./scripts/ios-simulator.sh "iPhone Air"               # Specific device
#   ./scripts/ios-simulator.sh "iPhone 17" "https://my-app.vercel.app"  # Custom URL
#

set -euo pipefail

# ANSI color codes (disabled if not a terminal or NO_COLOR is set)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[0;32m'
  BLUE=$'\033[0;34m'
  YELLOW=$'\033[1;33m'
  CYAN=$'\033[0;36m'
  MAGENTA=$'\033[0;35m'
  RED=$'\033[0;31m'
  DIM=$'\033[2m'
  NC=$'\033[0m'
else
  BOLD=''
  GREEN=''
  BLUE=''
  YELLOW=''
  CYAN=''
  MAGENTA=''
  RED=''
  DIM=''
  NC=''
fi

# Pre-defined simulator mapping
DEFAULT_DEVICE="iPhone 17 Pro"
DEFAULT_URL="http://localhost:3000"

print_help() {
  cat << EOF
${BOLD}QuickScan iOS Simulator Helper${NC}

Launch and test the QuickScan PWA inside an iOS Simulator.

${BOLD}Usage:${NC}
  $(basename "$0") [device] [url]
  $(basename "$0") --help | -h
  $(basename "$0") --list | -l

${BOLD}Arguments:${NC}
  device   Device name or UDID (default: "${DEFAULT_DEVICE}")
  url      URL to open in Safari (default: "${DEFAULT_URL}")

${BOLD}Available Simulators:${NC}
  - "iPhone 17 Pro"      (E6DC529E-53D9-4E15-A90C-DE514B8475D1) [Default]
  - "iPhone 17 Pro Max"  (BE9098D6-75D3-40F6-B9FA-51B7CA9E169A)
  - "iPhone Air"         (347AF1D0-D26A-4196-B818-8B75E6B7451C)
  - "iPhone 17"          (524FB5AF-9D8B-43F4-9532-B25B58E91917)
  - "iPhone 16e"         (46B3A946-F6EF-4BB0-8640-88EABBA775B7)

${BOLD}Examples:${NC}
  ./scripts/$(basename "$0")
  ./scripts/$(basename "$0") "iPhone Air"
  ./scripts/$(basename "$0") "iPhone 17" "https://my-app.vercel.app"
  ./scripts/$(basename "$0") "iPhone 16e" "http://localhost:3000"

EOF
}

list_devices() {
  echo "${BOLD}Known QuickScan Simulators:${NC}"
  echo "  • iPhone 17 Pro      (E6DC529E-53D9-4E15-A90C-DE514B8475D1) [Default]"
  echo "  • iPhone 17 Pro Max  (BE9098D6-75D3-40F6-B9FA-51B7CA9E169A)"
  echo "  • iPhone Air         (347AF1D0-D26A-4196-B818-8B75E6B7451C)"
  echo "  • iPhone 17          (524FB5AF-9D8B-43F4-9532-B25B58E91917)"
  echo "  • iPhone 16e         (46B3A946-F6EF-4BB0-8640-88EABBA775B7)"
  echo ""
  echo "${BOLD}Current Simulator Status (via xcrun simctl):${NC}"
  xcrun simctl list devices available | grep -E "iPhone (17|Air|16e)" || true
}

# Check prerequisites
if ! command -v xcrun >/dev/null 2>&1; then
  echo "${RED}Error: 'xcrun' is not found.${NC} Please install Xcode and the Command Line Tools." >&2
  exit 1
fi

if ! xcrun simctl list devices >/dev/null 2>&1; then
  echo "${RED}Error: 'xcrun simctl' command failed.${NC} Please make sure Xcode and CoreSimulator are working." >&2
  exit 1
fi

# Handle flag options
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  print_help
  exit 0
fi

if [ "${1:-}" = "-l" ] || [ "${1:-}" = "--list" ]; then
  list_devices
  exit 0
fi

DEVICE_INPUT="${1:-$DEFAULT_DEVICE}"
URL_INPUT="${2:-$DEFAULT_URL}"

# Ensure URL has protocol scheme
if [[ ! "$URL_INPUT" =~ ^[a-zA-Z]+:// ]]; then
  URL_INPUT="http://${URL_INPUT}"
fi

DEVICE_NAME=""
DEVICE_UDID=""

resolve_device() {
  local query="$1"
  local lower_query
  lower_query="$(echo "$query" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  case "$lower_query" in
    "iphone 17 pro" | "17 pro" | "17pro")
      DEVICE_NAME="iPhone 17 Pro"
      DEVICE_UDID="E6DC529E-53D9-4E15-A90C-DE514B8475D1"
      return 0
      ;;
    "iphone 17 pro max" | "17 pro max" | "17promax")
      DEVICE_NAME="iPhone 17 Pro Max"
      DEVICE_UDID="BE9098D6-75D3-40F6-B9FA-51B7CA9E169A"
      return 0
      ;;
    "iphone air" | "air")
      DEVICE_NAME="iPhone Air"
      DEVICE_UDID="347AF1D0-D26A-4196-B818-8B75E6B7451C"
      return 0
      ;;
    "iphone 17" | "17")
      DEVICE_NAME="iPhone 17"
      DEVICE_UDID="524FB5AF-9D8B-43F4-9532-B25B58E91917"
      return 0
      ;;
    "iphone 16e" | "16e")
      DEVICE_NAME="iPhone 16e"
      DEVICE_UDID="46B3A946-F6EF-4BB0-8640-88EABBA775B7"
      return 0
      ;;
    "e6dc529e-53d9-4e15-a90c-de514b8475d1")
      DEVICE_NAME="iPhone 17 Pro"
      DEVICE_UDID="E6DC529E-53D9-4E15-A90C-DE514B8475D1"
      return 0
      ;;
    "be9098d6-75d3-40f6-b9fa-51b7ca9e169a")
      DEVICE_NAME="iPhone 17 Pro Max"
      DEVICE_UDID="BE9098D6-75D3-40F6-B9FA-51B7CA9E169A"
      return 0
      ;;
    "347af1d0-d26a-4196-b818-8b75e6b7451c")
      DEVICE_NAME="iPhone Air"
      DEVICE_UDID="347AF1D0-D26A-4196-B818-8B75E6B7451C"
      return 0
      ;;
    "524fb5af-9d8b-43f4-9532-b25b58e91917")
      DEVICE_NAME="iPhone 17"
      DEVICE_UDID="524FB5AF-9D8B-43F4-9532-B25B58E91917"
      return 0
      ;;
    "46b3a946-f6ef-4bb0-8640-88eabba775b7")
      DEVICE_NAME="iPhone 16e"
      DEVICE_UDID="46B3A946-F6EF-4BB0-8640-88EABBA775B7"
      return 0
      ;;
  esac

  # Fallback: check simctl list directly for custom devices or UDIDs
  local match
  match=$(xcrun simctl list devices available | grep -E " \($query\) " | head -n 1 || true)
  if [ -n "$match" ]; then
    DEVICE_NAME=$(echo "$match" | sed -E 's/^[[:space:]]*(.*)[[:space:]]+\([A-F0-9-]+\).*/\1/')
    DEVICE_UDID="$query"
    return 0
  fi

  match=$(xcrun simctl list devices available | grep -E "^[[:space:]]*${query} \([A-F0-9-]+\)" | head -n 1 || true)
  if [ -n "$match" ]; then
    DEVICE_NAME="$query"
    DEVICE_UDID=$(echo "$match" | sed -E 's/.*\(([0-9A-F-]+)\).*/\1/')
    return 0
  fi

  match=$(xcrun simctl list devices available | grep -iE "^[[:space:]]*${query} \([A-F0-9-]+\)" | head -n 1 || true)
  if [ -n "$match" ]; then
    DEVICE_NAME=$(echo "$match" | sed -E 's/^[[:space:]]*(.*)[[:space:]]+\([A-F0-9-]+\).*/\1/')
    DEVICE_UDID=$(echo "$match" | sed -E 's/.*\(([0-9A-F-]+)\).*/\1/')
    return 0
  fi

  return 1
}

if ! resolve_device "$DEVICE_INPUT"; then
  echo "${RED}Error: Unknown or unavailable simulator '${DEVICE_INPUT}'.${NC}" >&2
  echo "" >&2
  echo "Available iOS Simulators:" >&2
  echo "  - iPhone 17 Pro      (E6DC529E-53D9-4E15-A90C-DE514B8475D1) [Default]" >&2
  echo "  - iPhone 17 Pro Max  (BE9098D6-75D3-40F6-B9FA-51B7CA9E169A)" >&2
  echo "  - iPhone Air         (347AF1D0-D26A-4196-B818-8B75E6B7451C)" >&2
  echo "  - iPhone 17          (524FB5AF-9D8B-43F4-9532-B25B58E91917)" >&2
  echo "  - iPhone 16e         (46B3A946-F6EF-4BB0-8640-88EABBA775B7)" >&2
  echo "" >&2
  echo "Run '$0 --list' to inspect all available devices." >&2
  exit 1
fi

echo "${CYAN}====================================================${NC}"
echo "${BOLD}📱 QuickScan iOS Simulator Runner${NC}"
echo "${CYAN}====================================================${NC}"
echo "Target Device: ${BOLD}${DEVICE_NAME}${NC} (${DEVICE_UDID})"
echo "Target URL   : ${BOLD}${URL_INPUT}${NC}"
echo ""

# Check if target URL is local and reachable (warning only)
if [[ "$URL_INPUT" =~ localhost || "$URL_INPUT" =~ 127\.0\.0\.1 ]]; then
  PORT=$(echo "$URL_INPUT" | sed -E 's#https?://[^:/]+(:([0-9]+))?.*#\2#')
  PORT="${PORT:-80}"
  if ! nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    echo "${YELLOW}⚠️  Notice: Local dev server does not appear to be running on port ${PORT}.${NC}"
    echo "${DIM}   Make sure to run 'npm run dev' so Safari can load the app.${NC}"
    echo ""
  fi
fi

# Boot simulator if not running & wait for it to fully boot
echo "${BLUE}▶ Checking simulator status...${NC}"
IS_BOOTED=$(xcrun simctl list devices | grep "$DEVICE_UDID" | grep -c "Booted" || true)

if [ "$IS_BOOTED" -gt 0 ]; then
  echo "${GREEN}✓ Simulator is already booted.${NC}"
else
  echo "${YELLOW}⏳ Booting simulator and waiting for system to start...${NC}"
  xcrun simctl bootstatus "$DEVICE_UDID" -b
  echo "${GREEN}✓ Simulator is fully booted.${NC}"
fi

# Bring up Simulator GUI window if Simulator.app is installed
if open -Ra Simulator 2>/dev/null; then
  echo "${BLUE}▶ Bringing Simulator window to focus...${NC}"
  open -a Simulator --args -CurrentDeviceUDID "$DEVICE_UDID"
fi

# Open Safari with the requested URL
echo "${BLUE}▶ Opening ${URL_INPUT} in Safari...${NC}"
xcrun simctl openurl "$DEVICE_UDID" "$URL_INPUT"
echo "${GREEN}✓ Safari opened with ${URL_INPUT}.${NC}"

echo ""
echo "${CYAN}====================================================${NC}"
echo "${BOLD}💡 Helpful Instructions for PWA Testing${NC}"
echo "${CYAN}====================================================${NC}"
echo ""
echo "${BOLD}1. Test PWA Installation (Standalone Mode):${NC}"
echo "   • In Safari on the simulator, tap the ${CYAN}Share${NC} icon (square with upward arrow)."
echo "   • Scroll down the share sheet and tap ${BOLD}'Add to Home Screen'${NC}."
echo "   • Tap ${BOLD}'Add'${NC} in the top right."
echo "   • The QuickScan icon will appear on the Home Screen. Tap it to test standalone PWA mode."
echo ""
echo "${BOLD}2. Offline Testing & Airplane Mode:${NC}"
echo "   • Open Control Center: swipe down from the top-right corner of the simulator screen."
echo "   • Tap the ${YELLOW}Airplane Mode${NC} icon to cut network access and test offline caching."
echo "   • Alternatively: Open the ${CYAN}Settings${NC} app in the simulator and toggle ${BOLD}Airplane Mode${NC}."
echo "   • QuickScan uses Service Worker caching and Dexie (IndexedDB) for offline functionality."
echo ""
echo "${BOLD}3. Safari Web Inspector & Debugging:${NC}"
echo "   • On your Mac, open desktop ${CYAN}Safari${NC}."
echo "   • Go to ${BOLD}Safari → Settings → Advanced${NC} and check ${BOLD}'Show features for web developers'${NC}."
echo "   • From the Mac menu bar, choose ${BOLD}Develop → ${DEVICE_NAME}${NC} → click your QuickScan page."
echo "   • Inspect DOM, Console logs, Network requests, IndexedDB databases, and Service Workers."
echo ""
echo "${BOLD}4. Simulator Camera Limitation:${NC}"
echo "   • ${YELLOW}Note:${NC} The iOS Simulator does ${RED}NOT${NC} support live camera hardware feeds."
echo "   • Calls to ${DIM}navigator.mediaDevices.getUserMedia()${NC} will fail or show mock frames."
echo "   • Test document/barcode scanning using file upload fallbacks or test on a physical iOS device."
echo ""
echo "${CYAN}====================================================${NC}"
