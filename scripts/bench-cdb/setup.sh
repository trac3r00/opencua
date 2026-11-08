#!/usr/bin/env bash
# Prepare only: never capture, drive the desktop, or call a model.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
fail() { printf 'BLOCKED: %s\n' "$*" >&2; exit 2; }
trap 'printf "BLOCKED: setup failed at line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR

mode="${1:-}"
[[ $# -le 1 && ( -z "$mode" || "$mode" == --prepare ) ]] ||
	fail "usage: bash scripts/bench-cdb/setup.sh [--prepare]"
# The OpenCUA arm drives host apps, and OpenCUA now refuses all input on the shared host (it acts only in its
# own isolated desktop). The arm is kept for the record; preparing the clone still works, running it does not.
[[ "$mode" == --prepare ]] ||
	fail "the cc-apple-cua arm needs host input, which OpenCUA refuses on the shared host; see README.md, Status"
for tool in git node uv npm timeout xcrun codesign; do
	command -v "$tool" >/dev/null || fail "missing $tool; install the named prerequisite"
done
pin="$(node -p 'require(process.argv[1]).upstream.sha' "$here/pins.json")"
requested="${CDB_PIN_SHA:-$pin}"
[[ "$requested" =~ ^[0-9a-f]{40}$ && "$requested" == "$pin" ]] ||
	fail "CDB_PIN_SHA=$requested is not the pinned full SHA $pin; refusing clone/apply"
[[ "$(sw_vers -productVersion)" == 26.* ]] || fail "macOS 26 is required"
[[ -x /opt/homebrew/bin/ffmpeg ]] || fail "missing /opt/homebrew/bin/ffmpeg; install ffmpeg"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' ||
	fail "Node 22 or later is required"
if [[ "$mode" != --prepare ]]; then
	missing=()
	for app in "LibreOffice" "Gnucash" "Google Chrome"; do
		[[ -d "/Applications/$app.app" ]] || missing+=("/Applications/$app.app")
	done
	[[ -x /opt/homebrew/bin/claude ]] || missing+=("/opt/homebrew/bin/claude")
	if ((${#missing[@]})); then
		fail "missing ${missing[*]}; install/provide these prerequisites, then rerun setup"
	fi
	[[ "$(/opt/homebrew/bin/claude --version)" == "$(node -p 'require(process.argv[1]).claude_code_version' "$here/pins.json")" ]] ||
		fail "Claude Code version differs from pins.json"
fi

root="${CDB_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/apple-cua-cdb.XXXXXX")}"
[[ "$root" == /* ]] || fail "CDB_ROOT must be absolute"
case "$root/" in
	"$repo/"*|/Users/cminseo/Developer/apple-cua/*)
		fail "CDB_ROOT must be outside the apple-cua checkouts" ;;
esac
mkdir -p "$root"
root="$(cd "$root" && pwd -P)"
marker="$root/.apple-cua-cdb"
patch_sha="$(shasum -a 256 "$here/apple-cua-arm.patch" | awk '{print $1}')"
identity="$pin $patch_sha"
if [[ -e "$marker" ]]; then
	[[ "$(<"$marker")" == "$identity" ]] || fail "stale CDB_ROOT pin or patch; choose a fresh directory"
	[[ "$(GIT_MASTER=1 git -C "$root" rev-parse HEAD)" == "$pin" ]] ||
		fail "stale CDB_ROOT HEAD; choose a fresh directory"
	GIT_MASTER=1 git -C "$root" apply --reverse --check "$here/apple-cua-arm.patch" ||
		fail "CDB_ROOT arm patch changed; choose a fresh directory"
else
	[[ -z "$(ls -A "$root")" ]] || fail "CDB_ROOT is not empty or task-owned; choose a fresh directory"
	timeout 180 env GIT_MASTER=1 git clone --filter=blob:none --no-checkout \
		https://github.com/trycua/cua.git "$root"
	timeout 180 env GIT_MASTER=1 git -C "$root" checkout --detach "$pin"
	GIT_MASTER=1 git -C "$root" apply --check "$here/apple-cua-arm.patch" ||
		fail "arm patch does not apply at pinned SHA $pin"
	GIT_MASTER=1 git -C "$root" apply "$here/apple-cua-arm.patch"
	printf '%s\n' "$identity" >"$marker"
fi
export CDB_ROOT="$root"
export CDB_BENCH_WORK="$root/work"
bench="$root/libs/cua-driver-bench/automated-eval/macos_bench"
mkdir -p "$CDB_BENCH_WORK/apple-home"

timeout 180 uv venv --allow-existing --python 3.12.11 "$root/venv"
timeout 180 uv pip install --python "$root/venv/bin/python" pytest==9.0.3
timeout 300 bash "$bench/swift/build.sh" "$CDB_BENCH_WORK/build"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$lsregister" -f "$CDB_BENCH_WORK/build/BenchLab.app" "$CDB_BENCH_WORK/build/BenchSentinel.app"
for app in "$root"/libs/cua-driver-bench/taskpack/tasks/shared/*/apps/*; do
	(
		cd "$app"
		timeout 300 npm ci
		if [[ ! -d node_modules/electron/dist ]]; then
			timeout 300 node node_modules/electron/install.js
		fi
	)
done
timeout 300 "$root/venv/bin/python" "$bench/tools/install_cua_driver.py" --work "$CDB_BENCH_WORK"

helper="$repo/packages/mcp/dist/opencua-mcp.app"
[[ -x "$helper/Contents/MacOS/opencua-mcp" && -f "$repo/packages/mcp/dist/server.js" ]] ||
	fail "missing built apple-cua server/helper; run isolated worktree setup as documented in README.md"
[[ "$("$helper/Contents/Resources/node" --version)" == "$(node -p 'require(process.argv[1]).apple_cua.node_version' "$here/pins.json")" ]] ||
	fail "bundled Node version differs from pins.json"

# Runtime files stay with the external clone; no upstream source enters this repository.
node --input-type=module - "$here/pins.json" "$repo" "$CDB_BENCH_WORK" "$bench" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const [pinsFile, repo, work, bench] = process.argv.slice(2);
const pins = JSON.parse(readFileSync(pinsFile, "utf8"));
const config = {
  helper_launcher: join(repo, pins.apple_cua.helper_launcher),
  server: join(repo, pins.apple_cua.server),
  node: join(repo, pins.apple_cua.node),
  skill: join(repo, pins.apple_cua.skill),
  allowed_bundle_ids: pins.apple_cua.env.OPENCUA_ALLOWED_BUNDLE_IDS.split(","),
};
const hashes = Object.fromEntries(["helper_launcher", "server", "node"].map(key =>
  [key, createHash("sha256").update(readFileSync(config[key])).digest("hex")]));
writeFileSync(join(work, "apple-cua.json"), JSON.stringify(config, null, 2) + "\n");
writeFileSync(join(work, "apple-cua-observed.json"), JSON.stringify({ ...config, hashes }, null, 2) + "\n");
const local = JSON.parse(readFileSync(join(bench, "pins.json"), "utf8"));
for (const key of ["claude_code_version", "macos_version", "macos_build"]) local[key] = pins[key];
writeFileSync(join(work, "pins-local.json"), JSON.stringify(local, null, 2) + "\n");
JS

codesign --verify --deep --strict "$helper" ||
	fail "helper signature is incomplete; complete stable signing before desktop preflight"
codesign -dvv "$helper" 2>&1 | grep -q 'Authority=apple-cua dev' ||
	fail "helper is not signed with apple-cua dev; link .signing and rebuild the helper"

printf 'PREPARED pinned upstream SHA %s\nCDB_ROOT=%s\nCDB_BENCH_WORK=%s\n' "$pin" "$root" "$CDB_BENCH_WORK"
if [[ "$mode" == --prepare ]]; then
	printf 'Preparation only; app prerequisites and desktop preflight are NOT certified.\n'
	exit 0
fi
printf 'Offline setup complete. Login/model response and Screen Recording remain untested; preflight requires DESKTOP GO.\n'
