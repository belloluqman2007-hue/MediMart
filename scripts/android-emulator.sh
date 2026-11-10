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
yes | "$SDKMANAGER" --licenses > /dev/null 2>&1 || true
if ! "$SDKMANAGER" --install "$IMAGE" "platform-tools" "emulator" 2>&1 | tee "$EVIDENCE/sdkmanager.log" | tail -5; then
  fail "System image unavailable" "sdkmanager could not install ${IMAGE}."
fi

step "Create the AVD"
echo no | "$AVDMANAGER" create avd -n "$AVD" -k "$IMAGE" --device pixel_5 --force > "$EVIDENCE/avdmanager.log" 2>&1 ||
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

if [ -n "$PAIRING_BASE" ]; then
  step "Pairing and offline synchronization from the device network path (${PAIRING_BASE})"
  node --import=tsx scripts/test-android-pairing.ts "$PAIRING_BASE" 2>&1 | tee "$EVIDENCE/pairing-sync.txt" ||
    fail "Pairing or synchronization failed" "The device pairing / offline sync contract failed; see pairing-sync.txt."
fi

step "PASSED: installed, launched and exercised on Android $(cat "$EVIDENCE/android-version.txt" 2>/dev/null || echo "$API_LEVEL")"
