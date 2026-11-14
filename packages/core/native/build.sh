#!/usr/bin/env bash
# Builds the native helpers of @opencua/core as universal binaries (arm64 + x86_64), so one checkout
# runs on Apple Silicon and Intel Macs alike:
#
#   libsckit.dylib   ScreenCaptureKit capture shim.
#   cursor-overlay   the agent cursor overlay.
#   permission-drag  the panel `opencua permissions grant` attaches to System Settings, to drag the helper app
#                    into a Privacy & Security list.
#
# Both target macOS 15.0, the oldest macOS opencua supports. Calling an API newer than that without an
# @available check is a build error, which keeps the target true. The script ends by recording the hashes of
# its inputs in build-inputs.sha256; scripts/setup.sh and `opencua doctor` compare them to tell whether the
# committed binaries still match their sources.
#
# Requires the Xcode Command Line Tools (clang, lipo) with a macOS SDK that ships ScreenCaptureKit.

set -euo pipefail

native_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
architectures=(-arch arm64 -arch x86_64)
deployment_target=(-mmacosx-version-min=15.0)
availability_errors=(-Werror=unguarded-availability -Werror=unguarded-availability-new)

for source in sckit.m cursor-overlay.m history-recorder.m opencua-surface.m guest-axdump.m permission-drag.m; do
	if [[ ! -f "${native_dir}/${source}" ]]; then
		echo "error: missing ${native_dir}/${source}" >&2
		exit 1
	fi
done

clang \
	"${architectures[@]}" \
	-dynamiclib \
	-install_name @rpath/libsckit.dylib \
	-O2 \
	-fobjc-arc \
	"${deployment_target[@]}" \
	"${availability_errors[@]}" \
	-framework ScreenCaptureKit \
	-framework CoreGraphics \
	-framework CoreAudio \
	-framework CoreMedia \
	-framework CoreVideo \
	-framework Foundation \
	-framework ImageIO \
	-framework CoreServices \
	"${native_dir}/sckit.m" \
	-o "${native_dir}/libsckit.dylib"
echo "built ${native_dir}/libsckit.dylib ($(lipo -archs "${native_dir}/libsckit.dylib"))"

clang \
	"${architectures[@]}" \
	-O2 \
	-fobjc-arc \
	"${deployment_target[@]}" \
	"${availability_errors[@]}" \
	-framework Cocoa \
	-framework Foundation \
	"${native_dir}/cursor-overlay.m" \
	-o "${native_dir}/cursor-overlay"
echo "built ${native_dir}/cursor-overlay ($(lipo -archs "${native_dir}/cursor-overlay"))"

clang \
	"${architectures[@]}" \
	-O2 \
	-fobjc-arc \
	"${deployment_target[@]}" \
	"${availability_errors[@]}" \
	-framework AppKit \
	-framework Foundation \
	-framework ApplicationServices \
	-framework CoreGraphics \
	-framework Carbon \
	"${native_dir}/history-recorder.m" \
	-o "${native_dir}/history-recorder"
echo "built ${native_dir}/history-recorder ($(lipo -archs "${native_dir}/history-recorder"))"

clang \
	"${architectures[@]}" \
	-O2 \
	-fobjc-arc \
	"${deployment_target[@]}" \
	"${availability_errors[@]}" \
	-framework AppKit \
	-framework Foundation \
	-framework WebKit \
	-framework CoreGraphics \
	"${native_dir}/opencua-surface.m" \
	-o "${native_dir}/opencua-surface"
echo "built ${native_dir}/opencua-surface ($(lipo -archs "${native_dir}/opencua-surface"))"

clang \
	"${architectures[@]}" \
	-O2 \
	-fobjc-arc \
	"${deployment_target[@]}" \
	"${availability_errors[@]}" \
	-framework AppKit \
	-framework Foundation \
	-framework CoreGraphics \
	"${native_dir}/permission-drag.m" \
	-o "${native_dir}/permission-drag"
echo "built ${native_dir}/permission-drag ($(lipo -archs "${native_dir}/permission-drag"))"

# Copied into agent-owned guests (Apple virtual Macs, always arm64) by the isolated server; never run on the host.
clang \
	-arch arm64 \
	-O2 \
	-fobjc-arc \
	"${deployment_target[@]}" \
	"${availability_errors[@]}" \
	-framework AppKit \
	-framework ApplicationServices \
	"${native_dir}/guest-axdump.m" \
	-o "${native_dir}/guest-axdump"
echo "built ${native_dir}/guest-axdump ($(lipo -archs "${native_dir}/guest-axdump"))"

(cd "${native_dir}" && shasum -a 256 build.sh sckit.m cursor-overlay.m history-recorder.m opencua-surface.m guest-axdump.m permission-drag.m >build-inputs.sha256)
echo "recorded input hashes in ${native_dir}/build-inputs.sha256"

# Sign the helpers with the stable identity (see scripts/sign-native.sh): ad-hoc builds change
# the cdhash every rebuild, which resets macOS TCC consents and re-prompts every app.
bash "$native_dir/../../../scripts/sign-native.sh" \
	"$native_dir/libsckit.dylib" \
	"$native_dir/cursor-overlay" \
	"$native_dir/opencua-surface" \
	"$native_dir/permission-drag"

# The always-on history watcher runs as its own launchd process, so it would otherwise get its own
# TCC entry and need Accessibility and Input Monitoring granted separately. Signing it with the
# opencua-mcp bundle identifier makes macOS charge its grant to the same app the rest of opencua
# already uses, so one approval covers it. Override the id with OPENCUA_BUNDLE_ID to match a custom
# helper bundle id.
OPENCUA_CODESIGN_IDENTIFIER="${OPENCUA_BUNDLE_ID:-dev.opencua.mcp}" \
	bash "$native_dir/../../../scripts/sign-native.sh" \
	"$native_dir/history-recorder"
