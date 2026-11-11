#!/usr/bin/env bash
# Install and launch the built MediMart APK in a headless Android emulator.
#
# This is deliberately explicit instead of a third-party composite action: every step prints what it
# is doing, and a failure names the step. Requirements: a Linux host with /dev/kvm, a JDK and an
# Android SDK (GitHub's ubuntu-latest image has all three).
#
# Usage: scripts/android-emulator.sh <api-level> <screenshot-dir> [pairing-base-url]
#   scripts/android-emulator.sh 30 evidence
#   scripts/android-emulator.sh 27 evidence-android81 http://10.0.2.2:4191
set -euo pipefail

API_LEVEL="${1:?usage: android-emulator.sh <api-level> <evidence-dir> [pairing-base-url]}"
EVIDENCE="${2:?usage: android-emulator.sh <api-level> <evidence-dir> [pairing-base-url]}"
PAIRING_BASE="${3:-}"
APK="${APK_PATH:-apk/medimart-debug.apk}"
PACKAGE=com.medimart.app
FAIL_MARKER="self-check failed"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
SDKMANAGER="$(command -v sdkmanager || echo "$SDK/cmdline-tools/latest/bin/sdkmanager")"
AVDMANAGER="$(command -v avdmanager || echo "$SDK/cmdline-tools/latest/bin/avdmanager")"
EMULATOR="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"
IMAGE="system-images;android-${API_LEVEL};google_apis;x86_64"
AVD="medimart-api${API_LEVEL}"

mkdir -p "$EVIDENCE"
step() { echo; echo "===== $* ====="; }

# Assert that the encrypted database really initialized and persisted on this device.
#
# "The app stayed open" is not evidence that its secure database works: the failure screen also
# stays open. This function greps the two evidence channels the application writes:
#   - StartupSelfCheck  → logcat tag MediMartStartup (Keystore + SQLCipher, before the WebView)
#   - diagnostics.ts    → Capacitor console → logcat tag Capacitor/Console ("[MediMart] [database]")
# and then inspects the on-device file itself: it must exist and must NOT be a plaintext SQLite file
# (a SQLCipher database has no "SQLite format 3" header).
check_database() {
  local phase="$1"
  local log="$EVIDENCE/logcat-${phase}.txt"
  "$ADB" logcat -d > "$log" || true

  grep -E "MediMartStartup" "$log" | sed -n '1,20p' | tee "$EVIDENCE/startup-self-check-${phase}.txt"
  grep -E "\[MediMart\] \[database\]" "$log" | sed -n '1,20p' | tee "$EVIDENCE/database-log-${phase}.txt"

  if grep -q "MediMartStartup.*${FAIL_MARKER}" "$log"; then
    fail "Native self-check failed (${phase})" "Android Keystore or SQLCipher failed on this device; see $EVIDENCE/startup-self-check-${phase}.txt."
  fi
  grep -q "MediMartStartup.*self-check ok" "$log" ||
    fail "Native self-check missing (${phase})" "The app did not report its Keystore/SQLCipher self-check; see $log."
  grep -q "\[MediMart\] \[database\] Encrypted database ready" "$log" ||
    fail "Secure database did not initialize (${phase})" "No 'Encrypted database ready' diagnostic in logcat; see $EVIDENCE/database-log-${phase}.txt."
  if grep -qE "\[MediMart\].*(could not initialize|initialization failed)" "$log"; then
    fail "Secure database failed to initialize (${phase})" "The application reported a storage failure; see $EVIDENCE/database-log-${phase}.txt."
  fi

  local files
  files=$("$ADB" shell run-as "$PACKAGE" ls -l databases 2>/dev/null | tr -d '\r' || true)
  echo "$files" > "$EVIDENCE/databases-${phase}.txt"
  echo "$files" | grep -q "medimartSQLite.db" ||
    fail "Database file missing (${phase})" "The encrypted database file is not in the app's private databases directory."
  # Header check: a SQLCipher file must not start with the plaintext SQLite magic.
  local header
  header=$("$ADB" shell run-as "$PACKAGE" head -c 16 databases/medimartSQLite.db 2>/dev/null | tr -d '\0' || true)
  echo "header: $header" | tee -a "$EVIDENCE/databases-${phase}.txt"
  case "$header" in
    "SQLite format 3"*) fail "Database is not encrypted (${phase})" "The database file starts with the plaintext SQLite header." ;;
  esac
}
annotate() {
  # Emit a GitHub annotation, escaping the characters that would truncate the message.
  local title="$1"
  shift
  local message="${*//'%'/%25}"
  message="${message//$'\n'/ }"
  echo "::error title=${title}::${message}"
}

cleanup() {
  if [ -n "${EMULATOR_PID:-}" ]; then
    kill "$EMULATOR_PID" 2>/dev/null || true
  fi
  "$ADB" kill-server 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  annotate "$1" "$2"
  echo "$2" >&2
  echo "----- emulator log tail -----" >&2
  tail -60 "$EVIDENCE/emulator.log" 2>/dev/null >&2 || true
  echo "----- logcat tail -----" >&2
  "$ADB" logcat -d 2>/dev/null | tail -80 >&2 || true
  exit 1
}

step "Environment"
uname -a
ls -l /dev/kvm || fail "No KVM" "This runner does not expose /dev/kvm, so the emulator cannot start."
"$SDKMANAGER" --version 2>&1 | head -3 || fail "No Android SDK" "sdkmanager was not found at $SDKMANAGER."

step "Install the API ${API_LEVEL} system image"
# `sdkmanager --licenses` reads stdin and can sit forever when nothing is piped into it; bound it.
timeout 300 sh -c "yes | \"$SDKMANAGER\" --licenses" > /dev/null 2>&1 || true
# Every step here is bounded: an unbounded download must fail with a reason, not consume the job.
if ! timeout 1500 "$SDKMANAGER" --install "$IMAGE" "platform-tools" "emulator" 2>&1 | tee "$EVIDENCE/sdkmanager.log" | tail -5; then
  fail "System image unavailable" "sdkmanager could not install ${IMAGE} within 25 minutes."
fi
[ "$(ls -A "$SDK" 2>/dev/null)" ] || fail "No Android SDK" "The Android SDK directory $SDK is empty."

step "Create the AVD"
timeout 300 sh -c "echo no | \"$AVDMANAGER\" create avd -n \"$AVD\" -k \"$IMAGE\" --device pixel_5 --force" > "$EVIDENCE/avdmanager.log" 2>&1 ||
  fail "AVD creation failed" "avdmanager could not create ${AVD}. See $EVIDENCE/avdmanager.log."
grep -E "hw.ramSize|image.sysdir" "$HOME/.android/avd/${AVD}.avd/config.ini" 2>/dev/null | head -4 || true

step "Boot the emulator (headless)"
"$EMULATOR" -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel on -memory 3072 > "$EVIDENCE/emulator.log" 2>&1 &
EMULATOR_PID=$!
"$ADB" start-server > /dev/null 2>&1 || true
# `adb wait-for-device` blocks forever when the emulator dies, which would silently burn the whole
# job timeout. Poll with a bound instead and say what is happening while waiting.
DEVICE_SEEN=""
for i in $(seq 1 60); do
  if [ -n "$("$ADB" devices | awk 'NR>1 && $2=="device"')" ]; then
    DEVICE_SEEN=1
    break
  fi
  if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    fail "The emulator exited" "qemu exited before the device came online (exit code captured in emulator.log)."
  fi
  [ $((i % 6)) -eq 0 ] && echo "  waiting for the emulator to come online (${i}0s): $("$ADB" devices | tail -n +2 | tr '\n' ' ')"
  sleep 10
done
[ -n "$DEVICE_SEEN" ] || fail "Emulator did not start" "adb never saw a device within 10 minutes; see emulator.log."
# Boot completed, not merely "device online": installing too early fails intermittently.
BOOTED=""
for i in $(seq 1 120); do
  if [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    BOOTED=1
    break
  fi
  if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    fail "The emulator exited while booting" "qemu exited before Android finished booting; see emulator.log."
  fi
  [ $((i % 12)) -eq 0 ] && echo "  booting Android ${API_LEVEL} (${i}0s elapsed, boot_completed=$( "$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r'))"
  sleep 10
done
[ -n "$BOOTED" ] || fail "Emulator did not finish booting" "sys.boot_completed never became 1 within 10 minutes."
"$ADB" shell getprop ro.build.version.release | tee "$EVIDENCE/android-version.txt"
"$ADB" shell input keyevent 82 > /dev/null 2>&1 || true

step "Install the APK"
"$ADB" install -r "$APK" 2>&1 | tee "$EVIDENCE/install.txt" | tail -3
"$ADB" shell pm list packages | grep -Fx "package:${PACKAGE}" ||
  fail "APK not installed" "The package ${PACKAGE} is not present after adb install."
"$ADB" shell dumpsys package "$PACKAGE" > "$EVIDENCE/package.txt" || true
grep -E "versionName|versionCode|targetSdk|minSdk" "$EVIDENCE/package.txt" | head -5 || true

step "Launch the application"
"$ADB" logcat -c || true
"$ADB" shell am start -W -n "${PACKAGE}/.MainActivity" 2>&1 | tee "$EVIDENCE/launch.txt" | tail -5
sleep 30
"$ADB" exec-out screencap -p > "$EVIDENCE/launch.png" || true
if [ -f "$EVIDENCE/launch.png" ]; then
  python3 - "$EVIDENCE/launch.png" <<'PY' || true
import sys
data = open(sys.argv[1], 'rb').read()
print(f"screenshot: {len(data)} bytes", "PNG" if data[:8] == b'\x89PNG\r\n\x1a\n' else "not a PNG")
print("distinct bytes:", len(set(data[200:])), "(a pure white or black screen is nearly uniform)")
PY
fi
"$ADB" logcat -d > "$EVIDENCE/logcat.txt" || true
"$ADB" shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -3 | tee "$EVIDENCE/resumed.txt" || true

step "Check that the application is the running, resumed activity"
if grep -E "FATAL EXCEPTION|AndroidRuntime: Process: ${PACKAGE}" "$EVIDENCE/logcat.txt"; then
  grep -A 30 "FATAL EXCEPTION" "$EVIDENCE/logcat.txt" > "$EVIDENCE/crash.txt" || true
  fail "The application crashed on launch" "logcat contains a FATAL EXCEPTION for ${PACKAGE}. See crash.txt."
fi
if ! grep -qE "mResumedActivity.*${PACKAGE}|topResumedActivity.*${PACKAGE}" "$EVIDENCE/resumed.txt"; then
  fail "The application is not on screen" "No resumed activity for ${PACKAGE} 30 seconds after launch (blank screen or immediate exit)."
fi
if grep -qE "ERR_CLEARTEXT_NOT_PERMITTED|net::ERR_BLOCKED_BY" "$EVIDENCE/logcat.txt"; then
  fail "WebView blocked a request" "The WebView reported a blocked request; see logcat.txt."
fi
echo "Application launched and stayed in the foreground."

step "Verify the encrypted database initialized on first launch"
check_database first-launch

step "Restart the application and verify the database and its identity persist"
"$ADB" shell am force-stop "$PACKAGE"
"$ADB" logcat -c || true
"$ADB" shell am start -W -n "${PACKAGE}/.MainActivity" 2>&1 | tee "$EVIDENCE/relaunch.txt" | tail -3
sleep 25
if ! "$ADB" shell dumpsys activity activities | grep -qE "mResumedActivity.*${PACKAGE}|topResumedActivity.*${PACKAGE}"; then
  fail "The application did not come back after a restart" "No resumed activity after force-stop and relaunch."
fi
check_database restart

if [ -n "$PAIRING_BASE" ]; then
  step "Pairing and offline synchronization from the device network path (${PAIRING_BASE})"
  node --import=tsx scripts/test-android-pairing.ts "$PAIRING_BASE" 2>&1 | tee "$EVIDENCE/pairing-sync.txt" ||
    fail "Pairing or synchronization failed" "The device pairing / offline sync contract failed; see pairing-sync.txt."
fi

step "PASSED: installed, launched and exercised on Android $(cat "$EVIDENCE/android-version.txt" 2>/dev/null || echo "$API_LEVEL")"
