#!/usr/bin/env bash
# One-command setup for opencua on a Mac with Apple Silicon or Intel and macOS 15 (Sequoia) or later.
#
#   ./scripts/setup.sh [--add-to-path] [--register <client>]... [--allow <apps>]
#                      [--delivery background|attended] [--toolset lean|full] [--rebuild-native] [--rebuild-helper]
#                      [--yes] [--no-doctor]
#
# Safe to re-run: every step checks before it acts, and a run after a failure picks up where the last one stopped.
# Outside this checkout it writes only:
#   - the `opencua` command, into $OPENCUA_BIN_DIR (default ~/.local/bin);
#   - the official Node.js LTS, into $OPENCUA_HOME/node (default ~/.opencua/node, checked against nodejs.org's
#     SHASUMS256.txt), when this Mac has no Node.js 20+ or no self-contained node to bundle into the helper;
#   - with --add-to-path, one line in your shell startup file, backed up first;
#   - through `opencua config`, $OPENCUA_HOME/config.json and the configs of the MCP clients you register with
#     (backed up and merged; a client you never registered is not touched).
#
# The signed helper app ("opencua-mcp") is built only when it is missing, fails its smoke run, was built from
# another launcher or Info.plist than this checkout has, or with --rebuild-helper: every build is a new code
# identity, and macOS then asks for Screen Recording and Accessibility again.
#
# In a terminal (and without --yes) setup asks what only a person can answer: whether to put opencua on PATH, on a
# first run whether to restrict apps and which MCP clients to register with, and then it walks through macOS's
# permission dialogs for "opencua-mcp" (Accessibility, Screen Recording, Automation), opening System Settings and
# waiting until each switch is on. Without a terminal it skips the questions and the closing doctor run lists what
# is left.
#
# OPENCUA_MACOS_VERSION pretends this Mac runs another macOS version; it exists to test the version check.
set -Eeuo pipefail

for legacy in ${!APPLE_CUA_@}; do
	current="OPENCUA_${legacy#APPLE_CUA_}"
	if [[ -z "${!current+x}" ]]; then export "$current=${!legacy}"; fi
done

readonly MIN_MACOS="15.0"
readonly MIN_MACOS_NAME="Sequoia"
readonly MIN_NODE_MAJOR=20
readonly TOTAL_STEPS=13
readonly LAUNCHER_MARKER="# opencua-launcher checkout="
readonly PATH_LINE_MARKER="# added by opencua"

absolute() {
	case "$1" in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s\n' "$PWD/$1" ;;
	esac
}

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
default_home="$HOME/.opencua"
if [[ ! -e "$default_home" && -d "$HOME/.apple-cua" ]]; then default_home="$HOME/.apple-cua"; fi
opencua_home="$(absolute "${OPENCUA_HOME:-$default_home}")"
bin_dir="$(absolute "${OPENCUA_BIN_DIR:-$HOME/.local/bin}")"
readonly repo opencua_home bin_dir
export OPENCUA_HOME="$opencua_home" OPENCUA_BIN_DIR="$bin_dir"
readonly managed_node_dir="$opencua_home/node"
readonly launcher="$bin_dir/opencua"
readonly legacy_launcher="$bin_dir/apple-cua"
readonly native_dir="$repo/packages/core/native"
readonly helper_app="$repo/packages/mcp/dist/opencua-mcp.app"
readonly helper_launcher="$helper_app/Contents/MacOS/opencua-mcp"
readonly helper_node="$helper_app/Contents/Resources/node"
readonly helper_stamp="$helper_app/Contents/Resources/helper-inputs.sha256"
readonly cli_js="$repo/packages/cli/dist/cli.js"
readonly lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

rebuild_native=0
rebuild_helper=0
assume_yes=0
add_path=0
run_doctor=1
registers=()
allow=""
allow_given=0
delivery=""
toolset=""
temp_dirs=()
current_step=0
current_title="starting"

usage() {
	cat <<'EOF'
usage: ./scripts/setup.sh [options]

Installs, builds and checks opencua in this checkout, and puts the opencua command in ~/.local/bin
(OPENCUA_BIN_DIR). Safe to re-run.

  --add-to-path           append the line that puts ~/.local/bin on PATH to your shell startup file (backed up first)
  --register <client>     add opencua to codex, claude, omo, gemini, cursor, hermes, openclaw, pi, or json (prints
                          a block for any other client); repeatable or
                          comma-separated; shortcut for: opencua config --register <client>
  --allow <apps>          optionally restrict apps by name or bundle id (e.g. TextEdit); replaces the saved list.
                          Without a restriction, any explicitly named app is available
  --delivery <mode>       background (default) or attended
  --toolset <profile>     full (default) or lean
  --rebuild-native        rebuild packages/core/native (default: use the committed universal binaries, rebuilt only
                          when their sources changed or a slice for this Mac is missing)
  --rebuild-helper        rebuild the signed helper app even if it works; macOS then asks for Screen Recording and
                          Accessibility again, because the rebuild is a new code identity
  -y, --yes               do not ask: download Node.js when needed, skip the first-run questions and the
                          permission walk-through (opencua config and opencua permissions grant do them later)
  --no-doctor             skip the closing doctor run
  -h, --help              show this help

Afterwards: opencua config (apps and MCP clients), opencua permissions grant, opencua doctor [--fix],
opencua update, opencua uninstall.
EOF
}

usage_error() {
	printf 'setup.sh: %s\n\n' "$1" >&2
	usage >&2
	exit 2
}

add_registers() {
	local client
	local -a clients
	IFS=, read -r -a clients <<<"$1"
	for client in ${clients[@]+"${clients[@]}"}; do
		case "$client" in
			omo | claude | codex | gemini | cursor | hermes | openclaw | pi | json) registers+=("$client") ;;
			*) usage_error "unknown --register client '$client' (expected omo, claude, codex, gemini, cursor, hermes, openclaw, pi or json)" ;;
		esac
	done
}

while (($# > 0)); do
	case "$1" in
		--add-to-path) add_path=1 ;;
		--rebuild-native) rebuild_native=1 ;;
		--rebuild-helper) rebuild_helper=1 ;;
		--no-doctor) run_doctor=0 ;;
		--register)
			(($# >= 2)) || usage_error "--register needs a client"
			add_registers "$2"
			shift
			;;
		--register=*) add_registers "${1#*=}" ;;
		--allow)
			(($# >= 2)) || usage_error "--allow needs a comma-separated list of apps"
			allow="$2"
			allow_given=1
			shift
			;;
		--allow=*)
			allow="${1#*=}"
			allow_given=1
			;;
		--delivery | --delivery=*)
			if [[ "$1" == *=* ]]; then delivery="${1#*=}"; else
				(($# >= 2)) || usage_error "--delivery needs background or attended"
				delivery="$2"
				shift
			fi
			[[ "$delivery" == background || "$delivery" == attended ]] || usage_error "--delivery must be background or attended"
			;;
		--toolset | --toolset=*)
			if [[ "$1" == *=* ]]; then toolset="${1#*=}"; else
				(($# >= 2)) || usage_error "--toolset needs lean or full"
				toolset="$2"
				shift
			fi
			[[ "$toolset" == lean || "$toolset" == full ]] || usage_error "--toolset must be lean or full"
			;;
		-y | --yes) assume_yes=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*) usage_error "unknown option: $1" ;;
	esac
	shift
done

# --- Output and failure handling ---------------------------------------------------------------------------------

step() {
	current_step=$((current_step + 1))
	current_title="$1"
	printf '\n[%d/%d] %s\n' "$current_step" "$TOTAL_STEPS" "$1"
}
ok() { printf '      ok  %s\n' "$*"; }
info() { printf '          %s\n' "$*"; }
warn() { printf '    warn  %s\n' "$*"; }

fail() {
	printf '\nsetup failed at step %d/%d (%s): %s\n' "$current_step" "$TOTAL_STEPS" "$current_title" "$1" >&2
	if (($# > 1)); then
		printf '  fix: %s\n' "$2" >&2
	fi
	exit 1
}

on_error() {
	local status=$1 line=$2 command=$3
	# shellcheck disable=SC2016 # the backticks are literal: they quote the failed command in the message
	printf '\nsetup failed at step %d/%d (%s): `%s` exited with status %d (setup.sh line %d)\n' \
		"$current_step" "$TOTAL_STEPS" "$current_title" "$command" "$status" "$line" >&2
	printf '  fix: read the output above, fix the cause, then re-run ./scripts/setup.sh; finished steps are skipped\n' >&2
	exit "$status"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

cleanup() {
	local dir
	for dir in ${temp_dirs[@]+"${temp_dirs[@]}"}; do
		rm -rf "$dir"
	done
}
trap cleanup EXIT

# Ask a yes/no question. Under `curl ... | bash` stdin is the download, so the question goes to the terminal itself
# (/dev/tty), the way Homebrew's and rustup's installers ask. With --yes, or with no terminal at all (CI), the default
# answer is taken.
confirm() {
	local question=$1 default=${2:-y} answer="" prompt="[Y/n]"
	[[ "$default" == y ]] || prompt="[y/N]"
	if ((assume_yes)); then
		[[ "$default" == y ]]
		return
	fi
	if [[ -t 0 ]]; then
		read -r -p "          $question $prompt " answer || answer=""
	elif (: </dev/tty) 2>/dev/null; then
		printf '          %s %s ' "$question" "$prompt" >/dev/tty
		read -r answer </dev/tty || answer=""
	else
		[[ "$default" == y ]]
		return
	fi
	answer="${answer:-$default}"
	[[ "$answer" == [Yy]* ]]
}

# Whether a person can be asked: not with --yes, and only when there is a terminal (stdin, or /dev/tty under
# `curl ... | bash`).
can_ask() {
	((!assume_yes)) && { [[ -t 0 ]] || (: </dev/tty) 2>/dev/null; }
}

version_at_least() {
	local -a have want
	local index count
	IFS=. read -r -a have <<<"$1"
	IFS=. read -r -a want <<<"$2"
	count=${#want[@]}
	((${#have[@]} > count)) && count=${#have[@]}
	for ((index = 0; index < count; index++)); do
		local left="${have[index]:-0}" right="${want[index]:-0}"
		[[ "$left" =~ ^[0-9]+$ && "$right" =~ ^[0-9]+$ ]] || return 1
		if ((10#$left > 10#$right)); then return 0; fi
		if ((10#$left < 10#$right)); then return 1; fi
	done
	return 0
}

# --- Node.js helpers ---------------------------------------------------------------------------------------------

# Bun answers process.versions.node and process.arch like Node, so a `node` on PATH that is really Bun
# passes every other check and lands in the bundle, where `node --version` then fails. Reject it by name.
node_is_node() {
	[[ "$("$1" -p 'typeof Bun === "undefined" && typeof Deno === "undefined"' 2>/dev/null)" == "true" ]]
}

node_is_usable() {
	local major
	major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
	[[ "$major" =~ ^[0-9]+$ ]] && ((major >= MIN_NODE_MAJOR))
}

# Only a self-contained node can be copied into the helper bundle: Homebrew's links libnode.dylib and Cellar paths
# (/opt/homebrew on Apple Silicon, /usr/local on Intel) that do not exist there. Same rule as build-tcc-helper.sh.
node_is_self_contained() {
	local dependencies
	dependencies="$(otool -L "$1" 2>/dev/null)" || return 1
	[[ -n "$dependencies" ]] || return 1
	! grep -Eq 'libnode|/opt/homebrew|/usr/local/(opt|Cellar)' <<<"$dependencies"
}

node_is_bundleable() {
	node_is_node "$1" && node_is_usable "$1" && node_is_self_contained "$1" && [[ "$("$1" -p process.arch 2>/dev/null)" == "$node_platform_arch" ]]
}

bundle_refusal() {
	if ! node_is_node "$1"; then
		echo "it is Bun or Deno pretending to be node, which cannot run the helper"
	elif ! node_is_usable "$1"; then
		echo "it does not run or is older than Node $MIN_NODE_MAJOR"
	elif ! node_is_self_contained "$1"; then
		echo "it links shared libraries (libnode.dylib or Homebrew paths), so it cannot live inside the app bundle"
	else
		echo "it is built for $("$1" -p process.arch 2>/dev/null || echo unknown) and this Mac needs $node_platform_arch"
	fi
}

# The official Node.js LTS for this Mac's architecture in $OPENCUA_HOME/node, downloaded once and verified against
# SHASUMS256.txt. Its bin/node is self-contained, so it can also be bundled into the helper.
ensure_managed_node() {
	if [[ -x "$managed_node_dir/bin/node" ]] && node_is_node "$managed_node_dir/bin/node" &&
		node_is_usable "$managed_node_dir/bin/node"; then
		info "reusing $managed_node_dir ($("$managed_node_dir/bin/node" --version))"
		return 0
	fi
	confirm "Download the official Node.js LTS for $node_os-$node_platform_arch from nodejs.org into $managed_node_dir?" y ||
		fail "a Node.js download was declined" \
			"install Node.js $MIN_NODE_MAJOR+ from https://nodejs.org (the macOS installer), or re-run with --yes"
	local index version tarball base tmp expected actual
	index="$(curl -fsSL --retry 2 https://nodejs.org/dist/index.tab)" ||
		fail "cannot reach nodejs.org to look up the current Node.js LTS" \
			"check the network, or install Node.js $MIN_NODE_MAJOR+ yourself and re-run"
	local archive_platform="$node_os"
	[[ "$node_os" != darwin ]] || archive_platform=osx
	version="$(awk -F'\t' -v want="$archive_platform-$node_platform_arch" \
		'NR > 1 && $10 != "-" && index($3, want) > 0 { print $1; exit }' <<<"$index")"
	[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
		fail "nodejs.org/dist/index.tab lists no LTS release for $node_os-$node_platform_arch" \
			"install Node.js $MIN_NODE_MAJOR+ yourself and re-run"
	tarball="node-$version-$node_os-$node_platform_arch.tar.gz"
	base="https://nodejs.org/dist/$version"
	tmp="$(mktemp -d "${TMPDIR:-/tmp}/opencua-node.XXXXXX")"
	temp_dirs+=("$tmp")
	info "downloading $base/$tarball"
	curl -fsSL --retry 2 -o "$tmp/$tarball" "$base/$tarball" ||
		fail "downloading $tarball failed" "check the network and re-run"
	curl -fsSL --retry 2 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" ||
		fail "downloading SHASUMS256.txt for $version failed" "check the network and re-run"
	expected="$(awk -v file="$tarball" '$2 == file { print $1 }' "$tmp/SHASUMS256.txt")"
	actual="$(shasum -a 256 "$tmp/$tarball" | awk '{ print $1 }')"
	[[ -n "$expected" && "$expected" == "$actual" ]] ||
		fail "$tarball does not match nodejs.org's SHASUMS256.txt (expected ${expected:-no entry}, got $actual)" \
			"re-run to download it again; if it keeps failing, install Node.js yourself"
	info "sha256 $actual matches SHASUMS256.txt"
	tar -xzf "$tmp/$tarball" -C "$tmp"
	mkdir -p "$(dirname "$managed_node_dir")"
	rm -rf "$managed_node_dir.partial"
	mv "$tmp/node-$version-$node_os-$node_platform_arch" "$managed_node_dir.partial"
	rm -rf "$managed_node_dir"
	mv "$managed_node_dir.partial" "$managed_node_dir"
	node_is_usable "$managed_node_dir/bin/node" ||
		fail "the downloaded Node.js $version does not run on macOS $macos_version" \
			"install a Node.js $MIN_NODE_MAJOR+ build that supports this macOS from https://nodejs.org"
	info "installed Node.js $version in $managed_node_dir"
}

# Sets helper_node_source to a self-contained Node.js 20+ for this architecture: OPENCUA_NODE when set, else the
# first one on PATH, else the managed download.
select_helper_node() {
	helper_node_source=""
	local candidate real seen=" "
	if [[ -n "${OPENCUA_NODE:-}" ]]; then
		real="$("$OPENCUA_NODE" -p process.execPath 2>/dev/null)" || fail "OPENCUA_NODE=$OPENCUA_NODE does not run"
		node_is_bundleable "$real" ||
			fail "OPENCUA_NODE=$OPENCUA_NODE cannot be bundled: $(bundle_refusal "$real")" \
				"point OPENCUA_NODE at the node of the official nodejs.org tarball or installer, or unset it"
		helper_node_source="$real"
		return 0
	fi
	while IFS= read -r candidate; do
		[[ -n "$candidate" ]] || continue
		real="$("$candidate" -p process.execPath 2>/dev/null)" || continue
		[[ "$seen" == *" $real "* ]] && continue
		seen="$seen$real "
		if node_is_bundleable "$real"; then
			helper_node_source="$real"
			info "bundling the self-contained node at $real ($("$real" --version))"
			return 0
		fi
		info "not bundling $real: $(bundle_refusal "$real")"
	done < <(
		type -ap node 2>/dev/null || true
		if [[ -x "$managed_node_dir/bin/node" ]]; then printf '%s\n' "$managed_node_dir/bin/node"; fi
	)
	info "no self-contained node on PATH, so the helper gets the official Node.js LTS"
	ensure_managed_node
	real="$("$managed_node_dir/bin/node" -p process.execPath)"
	node_is_bundleable "$real" || fail "the node in $managed_node_dir cannot be bundled: $(bundle_refusal "$real")"
	helper_node_source="$real"
}

# --- Helper app ---------------------------------------------------------------------------------------------------

# Exits 0 when the helper is intact: launcher and bundled node present, the bundle signature verifies, the bundled
# node is 20+, and the launcher runs a script through it. Prints why otherwise.
helper_smoke() {
	if [[ ! -x "$helper_launcher" || ! -x "$helper_node" ]]; then
		echo "its launcher or bundled node is missing"
		return 1
	fi
	local output
	if ! output="$(/usr/bin/codesign --verify --deep --strict "$helper_app" 2>&1)"; then
		echo "codesign --verify failed: $output"
		return 1
	fi
	if ! node_is_usable "$helper_node"; then
		echo "its bundled node does not run or is older than Node $MIN_NODE_MAJOR"
		return 1
	fi
	if ! output="$("$helper_launcher" -e 'process.stdout.write("ok")' 2>&1)" || [[ "$output" != "ok" ]]; then
		echo "the launcher did not run a script through its node: ${output:-no output}"
		return 1
	fi
}

helper_identity() {
	local details
	details="$(/usr/bin/codesign -dvvv "$helper_app" 2>&1 || true)"
	printf '%s, CDHash %s' "$(sed -n 's/^Identifier=//p' <<<"$details")" "$(sed -n 's/^CDHash=//p' <<<"$details")"
}

run_pnpm() {
	(cd "$repo" && "${pnpm_command[@]}" "$@")
}

# pnpm's own output (download progress, native addon builds, bin links that wait for the build, its approve-builds
# notice) means nothing to someone installing opencua, so it goes to a log that is shown only when the step fails.
run_pnpm_logged() {
	local log="$opencua_home/logs/$1.log"
	shift
	mkdir -p "$opencua_home/logs"
	if ! run_pnpm "$@" >"$log" 2>&1; then
		tail -n 40 "$log" | sed 's/^/          /'
		fail "pnpm $* did not finish" "the full output is in $log"
	fi
}

# --- The opencua command ----------------------------------------------------------------------------------------

# A launcher that runs this checkout's CLI with the node setup used, and with the OPENCUA_HOME and
# OPENCUA_BIN_DIR of this setup unless the caller sets them. Its second line names the checkout, which is how
# `opencua uninstall` and later setups recognise it.
write_launcher() {
	local q_home q_bin q_node q_cli q_setup
	q_home="$(printf '%q' "$opencua_home")"
	q_bin="$(printf '%q' "$bin_dir")"
	q_node="$(printf '%q' "$1")"
	q_cli="$(printf '%q' "$cli_js")"
	q_setup="$(printf '%q' "$repo/scripts/setup.sh")"
	cat <<LAUNCHER
#!/bin/bash
$LAUNCHER_MARKER$repo
# The opencua command, written by the setup of that checkout; \`opencua uninstall\` removes it.
for legacy in \${!APPLE_CUA_@}; do
	current="OPENCUA_\${legacy#APPLE_CUA_}"
	if [[ -z "\${!current+x}" ]]; then export "\$current=\${!legacy}"; fi
done
if [[ -z "\${OPENCUA_HOME+x}" ]]; then export OPENCUA_HOME=$q_home; fi
if [[ -z "\${OPENCUA_BIN_DIR+x}" ]]; then export OPENCUA_BIN_DIR=$q_bin; fi
node=$q_node
if [[ ! -x "\$node" ]]; then node="\$(command -v node || true)"; fi
if [[ -z "\$node" ]]; then
	setup=$q_setup
	echo "opencua: found no node to run with; re-run \$setup" >&2
	exit 1
fi
exec "\$node" $q_cli "\$@"
LAUNCHER
}

shell_rc_file() {
	case "$(basename "${SHELL:-/bin/zsh}")" in
		zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash) printf '%s\n' "$HOME/.bash_profile" ;;
		fish) printf '%s\n' "$HOME/.config/fish/config.fish" ;;
		*) printf '%s\n' "$HOME/.profile" ;;
	esac
}

# The line that puts bin_dir on PATH, in the syntax of the startup file it goes into. $HOME and $PATH are written
# literally, for the shell to expand when it starts.
# shellcheck disable=SC2016
path_line() {
	local dir=$bin_dir
	if [[ "$dir" == "$HOME"/* ]]; then dir='$HOME'"${dir#"$HOME"}"; fi
	if [[ "$1" == *.fish ]]; then
		printf 'set -gx PATH "%s" $PATH %s\n' "$dir" "$PATH_LINE_MARKER"
	else
		printf 'export PATH="%s:$PATH" %s\n' "$dir" "$PATH_LINE_MARKER"
	fi
}

add_to_path() {
	local rc line backup=""
	rc="$(shell_rc_file)"
	line="$(path_line "$rc")"
	if [[ -f "$rc" ]] && grep -qF "$PATH_LINE_MARKER" "$rc"; then
		ok "$rc already puts $bin_dir on PATH"
		return 0
	fi
	mkdir -p "$(dirname "$rc")"
	if [[ -f "$rc" ]]; then
		backup="$rc.bak-$(date +%Y%m%d-%H%M%S)"
		[[ ! -e "$backup" ]] || backup="$backup-$$"
		cp -p "$rc" "$backup"
		if [[ -s "$rc" && -n "$(tail -c 1 "$rc")" ]]; then printf '\n' >>"$rc"; fi
	fi
	printf '%s\n' "$line" >>"$rc"
	ok "added $bin_dir to PATH in $rc${backup:+ (backup: $backup)}"
	info "new terminals find opencua; in this one run: ${line% "$PATH_LINE_MARKER"}"
}

# --- 1. macOS ----------------------------------------------------------------------------------------------------

step "macOS version and architecture"
host_os="$(uname -s)"
case "$host_os" in
	Darwin) node_os=darwin ;;
	Linux) node_os=linux ;;
	*) fail "unsupported OS $host_os; on Windows use scripts/install.ps1" ;;
esac
macos_version=""
if [[ "$host_os" == Darwin ]]; then
macos_version="${OPENCUA_MACOS_VERSION:-$(sw_vers -productVersion)}"
version_at_least "$macos_version" "$MIN_MACOS" ||
	fail "opencua supports macOS $MIN_MACOS ($MIN_MACOS_NAME) and later, and this Mac runs macOS $macos_version" \
		"update macOS in System Settings > General > Software Update, then re-run ./scripts/setup.sh"
# hw.optional.arm64 names the CPU even for a process under Rosetta, where uname -m says x86_64.
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then
	host_arch=arm64
	node_platform_arch=arm64
	machine="Apple Silicon"
else
	host_arch=x86_64
	node_platform_arch=x64
	machine=Intel
fi
if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
	warn "this shell runs under Rosetta; setup still builds for this Mac's native $host_arch"
fi
ok "macOS $macos_version on $machine ($host_arch)"
else
	host_arch="$(uname -m)"
	case "$host_arch" in
		aarch64 | arm64) node_platform_arch=arm64 ;;
		x86_64) node_platform_arch=x64 ;;
		*) fail "unsupported Linux architecture $host_arch" ;;
	esac
	ok "Linux on $host_arch"
fi

# --- 2. Command Line Tools ---------------------------------------------------------------------------------------

step "Xcode Command Line Tools"
if [[ "$host_os" == Darwin ]]; then
developer_dir="$(xcode-select -p 2>/dev/null || true)"
[[ -n "$developer_dir" && -d "$developer_dir" ]] ||
	fail "the Xcode Command Line Tools are not installed" "run: xcode-select --install   then re-run ./scripts/setup.sh"
for tool in clang otool lipo; do
	xcrun --find "$tool" >/dev/null 2>&1 ||
		fail "$tool is missing from $developer_dir" "run: xcode-select --install   (or sudo xcode-select --reset)"
done
[[ -x /usr/bin/codesign ]] || fail "/usr/bin/codesign is missing" "reinstall the Command Line Tools: xcode-select --install"
clang --version >/dev/null 2>&1 ||
	fail "clang does not run, which usually means the Xcode license is not accepted yet" "run: sudo xcodebuild -license accept"
ok "$(clang --version 2>/dev/null | sed -n 1p) in $developer_dir"
else
	bash "$repo/scripts/check-linux-deps.sh"
fi

# --- 3. Node.js --------------------------------------------------------------------------------------------------

step "Node.js $MIN_NODE_MAJOR or later"
first_node="$(command -v node 2>/dev/null || true)"
# Agent harnesses put a `node` that is really Bun first on PATH; pnpm and the build need Node itself, so take the
# first real Node on PATH and put it in front.
build_node=""
while IFS= read -r candidate; do
	if node_is_node "$candidate" && node_is_usable "$candidate"; then
		build_node="$candidate"
		break
	fi
done < <(type -ap node 2>/dev/null || true)
if [[ -n "$build_node" ]]; then
	if [[ "$build_node" != "$first_node" ]]; then
		info "skipping $first_node: $(bundle_refusal "$first_node")"
		PATH="$(dirname "$build_node"):$PATH"
		export PATH
	fi
	ok "$build_node ($("$build_node" --version))"
else
	if [[ -n "$first_node" ]]; then
		warn "$first_node cannot build opencua: $(bundle_refusal "$first_node")"
	else
		info "no node on PATH"
	fi
	ensure_managed_node
	export PATH="$managed_node_dir/bin:$PATH"
	build_node="$managed_node_dir/bin/node"
	ok "$build_node ($(node --version))"
fi
if [[ "$("$build_node" -p process.arch 2>/dev/null || true)" != "$node_platform_arch" ]]; then
	warn "$build_node is an Intel (x64) build running under Rosetta; install the native $node_platform_arch Node.js from https://nodejs.org for full speed"
fi

# --- 4. pnpm -----------------------------------------------------------------------------------------------------

step "pnpm"
pnpm_version="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$repo/package.json")"
[[ -n "$pnpm_version" ]] || fail "package.json names no pnpm version in packageManager"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v pnpm >/dev/null 2>&1 && [[ "$(cd "$repo" && pnpm --version 2>/dev/null | tail -n 1)" == "$pnpm_version" ]]; then
	pnpm_command=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
	pnpm_command=(corepack "pnpm@$pnpm_version")
elif command -v npx >/dev/null 2>&1; then
	pnpm_command=(npx --yes "pnpm@$pnpm_version")
else
	fail "neither pnpm $pnpm_version, corepack nor npx is available" "install pnpm: npm install -g pnpm@$pnpm_version"
fi
pnpm_found="$(cd "$repo" && "${pnpm_command[@]}" --version 2>/dev/null | tail -n 1)" || pnpm_found=""
[[ "$pnpm_found" == "$pnpm_version" ]] ||
	fail "\`${pnpm_command[*]} --version\` printed '${pnpm_found:-nothing}' instead of $pnpm_version" \
		"install pnpm $pnpm_version (npm install -g pnpm@$pnpm_version) and re-run"
ok "pnpm $pnpm_version via ${pnpm_command[*]} (the version package.json pins)"

# --- 5. Dependencies ---------------------------------------------------------------------------------------------

step "dependencies (pnpm install --frozen-lockfile)"
run_pnpm_logged setup-dependencies install --frozen-lockfile
ok "node_modules matches pnpm-lock.yaml (log: $opencua_home/logs/setup-dependencies.log)"

# --- 6. Native binaries ------------------------------------------------------------------------------------------

step "native binaries (universal arm64 + x86_64)"
if [[ "$host_os" == Darwin ]]; then
native_reason=""
if ((rebuild_native)); then
	native_reason="--rebuild-native was given"
else
	for binary in libsckit.dylib cursor-overlay history-recorder opencua-surface; do
		if [[ ! -f "$native_dir/$binary" ]]; then
			native_reason="$binary is missing"
			break
		fi
		if ! lipo "$native_dir/$binary" -verify_arch "$host_arch" >/dev/null 2>&1; then
			native_reason="$binary has no $host_arch slice"
			break
		fi
	done
	# guest-axdump runs inside the arm64 guest, so it is checked for presence, not for this Mac's slice.
	if [[ -z "$native_reason" && ! -f "$native_dir/guest-axdump" ]]; then
		native_reason="guest-axdump is missing"
	fi
	if [[ -z "$native_reason" ]] && ! (cd "$native_dir" && shasum -a 256 -c --status build-inputs.sha256 >/dev/null 2>&1); then
		native_reason="their sources changed since they were built (build-inputs.sha256 does not match)"
	fi
fi
if [[ -n "$native_reason" ]]; then
	info "building because $native_reason"
	"$native_dir/build.sh"
fi
ok "libsckit.dylib ($(lipo -archs "$native_dir/libsckit.dylib")), cursor-overlay ($(lipo -archs "$native_dir/cursor-overlay")), history-recorder ($(lipo -archs "$native_dir/history-recorder")), opencua-surface, guest-axdump${native_reason:+, rebuilt}"
else
	ok "skipped macOS native binaries on Linux"
fi

# --- 7. TypeScript -----------------------------------------------------------------------------------------------

step "TypeScript build"
run_pnpm_logged setup-build-core --filter @opencua/core run build:ts
run_pnpm_logged setup-build --filter @opencua/mcp --filter @opencua/cli --filter @opencua/pi-extension --filter @opencua/agent \
	--filter @opencua/browser run build
ok "built core, mcp, cli, pi-extension, agent and browser"

# --- 8. Signed helper app ----------------------------------------------------------------------------------------

step "signed helper app (\"opencua-mcp\")"
if [[ "$host_os" == Darwin ]]; then
helper_reason=""
if ((rebuild_helper)); then
	helper_reason="--rebuild-helper was given"
elif [[ ! -d "$helper_app" ]]; then
	helper_reason="it does not exist yet"
elif [[ ! -x "$helper_app/Contents/MacOS/history-recorder" ]]; then
	helper_reason="it does not contain the cua-history watcher yet"
elif ! helper_problem="$(helper_smoke)"; then
	helper_reason="its smoke run failed: $helper_problem"
elif [[ -f "$helper_stamp" && "$(<"$helper_stamp")" != "$(bash "$repo/scripts/build-tcc-helper.sh" --inputs-digest)" ]]; then
	helper_reason="this checkout has another launcher or Info.plist than the one it was built from"
fi
if [[ -z "$helper_reason" ]]; then
	# Idempotent: System Settings lists the helper, and tccutil finds it, only once LaunchServices knows it.
	"$lsregister" -f "$helper_app" || warn "LaunchServices did not register $helper_app, so System Settings may not list it"
	ok "kept $helper_app ($(helper_identity)), so its permission grants still apply"
else
	if [[ -d "$helper_app" ]]; then
		warn "rebuilding the helper because $helper_reason"
		if [[ ! -f "$repo/.signing/opencua-signing.keychain-db" && ! -f "$repo/.signing/apple-cua-signing.keychain-db" ]]; then
		warn "the rebuild is ad-hoc signed, a new code identity: macOS will ask again for Screen Recording and Accessibility"
	fi
		info "helpers built before the opencua-mcp name was used are listed as \"node\" in Privacy & Security;"
		info "that entry is no longer used and can be removed there with the minus button"
	else
		info "building it because $helper_reason"
	fi
	select_helper_node
	# A helper from before the OpenCUA rename is rebuilt as dev.opencua.mcp. Clear the old id's grants while
	# LaunchServices still knows that app, so Privacy & Security does not list "opencua-mcp" twice.
	previous_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$helper_app/Contents/Info.plist" 2>/dev/null || true)"
	if [[ "$previous_bundle_id" == "dev.applecua.mcp" && "${OPENCUA_BUNDLE_ID:-dev.opencua.mcp}" != "dev.applecua.mcp" ]]; then
		if /usr/bin/tccutil reset All dev.applecua.mcp >/dev/null 2>&1; then
			info "removed the permission entries of the old dev.applecua.mcp helper; grant \"opencua-mcp\" once in step 12"
		else
			warn "could not remove the old dev.applecua.mcp permission entries; remove the stale \"opencua-mcp\" in Privacy & Security"
		fi
	fi
	OPENCUA_NODE="$helper_node_source" "$repo/scripts/build-tcc-helper.sh" 2>&1 | sed 's/^/          /'
	if ! helper_problem="$(helper_smoke)"; then
		fail "the freshly built helper failed its smoke run: $helper_problem" \
			"re-run with --rebuild-helper; if it fails again, set OPENCUA_NODE to a node from https://nodejs.org"
	fi
	ok "built $helper_app ($(helper_identity)) bundling Node $("$helper_node" --version)"
fi
else
	ok "skipped macOS helper app, signing and LaunchServices on Linux"
fi

# --- 9. The opencua command ------------------------------------------------------------------------------------

step "the opencua command"
cua="node $cli_js"
if [[ (-e "$launcher" || -L "$launcher") ]] &&
	! sed -n 2p "$launcher" 2>/dev/null | grep -Eq '^# (opencua|apple-cua)-launcher checkout='; then
	warn "$launcher exists and was not written by opencua setup, so it was left as it is"
	info "remove it and re-run setup to get the opencua command; until then run: $cua <command>"
else
	previous="$(sed -n "2s/^$LAUNCHER_MARKER//p" "$launcher" 2>/dev/null || true)"
	mkdir -p "$bin_dir"
	write_launcher "$build_node" >"$launcher.tmp-$$"
	chmod 755 "$launcher.tmp-$$"
	mv -f "$launcher.tmp-$$" "$launcher"
	if [[ -n "$previous" && "$previous" != "$repo" ]]; then
		ok "$launcher now runs this checkout (it ran $previous before)"
	else
		ok "$launcher runs this checkout"
	fi
	cua="$launcher"
	case ":$PATH:" in
		*":$bin_dir:"*)
			ok "$bin_dir is on PATH"
			cua="opencua"
			;;
		*)
			if ((add_path)) ||
				{ can_ask && confirm "$bin_dir is not on PATH. Add it in $(shell_rc_file) (backed up first)?" y; }; then
				add_to_path
				cua="opencua"
			else
				warn "$bin_dir is not on PATH, so a new terminal does not find opencua yet"
				info "add it with: $repo/scripts/setup.sh --add-to-path   (appends this line to $(shell_rc_file), backed up first)"
				info "  $(path_line "$(shell_rc_file)")"
			fi
			;;
	esac
fi

if [[ (-e "$legacy_launcher" || -L "$legacy_launcher") ]] &&
	! sed -n 2p "$legacy_launcher" 2>/dev/null | grep -Eq '^# (opencua|apple-cua)-launcher checkout='; then
	warn "$legacy_launcher is foreign; left it alone"
else
	mkdir -p "$bin_dir"
	write_launcher "$build_node" >"$legacy_launcher.tmp-$$"
	chmod 755 "$legacy_launcher.tmp-$$"
	mv -f "$legacy_launcher.tmp-$$" "$legacy_launcher"
	ok "$legacy_launcher is a compatibility alias for opencua"
fi

# --- 10. Background browser bridge --------------------------------------------------------------------------------

step "background browser bridge"
if [[ "$host_os" != Darwin || "${OPENCUA_BROWSER:-on}" == "off" ]]; then
	ok "skipped: browser service setup is macOS-only or OPENCUA_BROWSER=off"
else
	if node "$cli_js" browser setup --no-wait --no-open 2>&1 | sed 's/^/          /'; then
		ok "browser service installed; load the unpacked extension once when convenient"
	else
		warn "browser setup did not finish; retry with: $cua browser setup"
	fi
fi

# --- 11. MCP client registration ---------------------------------------------------------------------------------

step "MCP client registration"
config_arguments=()
for client in ${registers[@]+"${registers[@]}"}; do
	config_arguments+=(--register "$client")
done
if ((allow_given)); then config_arguments+=(--disallow all --allow "$allow"); fi
if [[ -n "$delivery" ]]; then config_arguments+=(--delivery "$delivery"); fi
if [[ -n "$toolset" ]]; then config_arguments+=(--toolset "$toolset"); fi
if ((${#config_arguments[@]} == 0)) && [[ ! -e "$opencua_home/config.json" ]] && can_ask; then
	info "first run: optionally restrict apps and choose the MCP clients to register with"
	# Its questions must reach the terminal, so its output is not piped through sed like the other steps'.
	node "$cli_js" config ||
		fail "opencua config did not complete" "read the messages above, then run: $cua config"
	ok "opencua config (answered above)"
else
	offer_new_clients=0
	if ((${#config_arguments[@]} == 0)); then
		config_arguments=(--apply)
		can_ask && offer_new_clients=1
	fi
	if ! node "$cli_js" config "${config_arguments[@]}" 2>&1 | sed 's/^/          /'; then
		fail "the MCP client registration did not complete" \
			"read the messages above, then run: $cua config; a config file that could not be read was left untouched"
	fi
	ok "opencua config ${config_arguments[*]}"
	# After --apply, so a client registered here is reported once rather than again as "already registered".
	# The question reaches the terminal, so no sed pipe.
	if ((offer_new_clients)); then
		node "$cli_js" config --detect ||
			warn "could not check for newly installed agent clients; run: $cua config --detect"
	fi
fi

# --- 12. Permissions -----------------------------------------------------------------------------------------------

step "permissions of \"opencua-mcp\" (Accessibility, Screen Recording, Automation)"
if [[ "$host_os" != Darwin ]]; then
	ok "skipped macOS TCC permissions on Linux; use an accessible desktop session"
elif ((assume_yes)); then
	ok "skipped: --yes was given"
	info "grant them with: $cua permissions grant"
else
	# Shows macOS's dialogs, opens System Settings and moves on as soon as each switch is on. In a terminal, typing s
	# skips one; without one (an agent running setup) it watches each switch for up to five minutes, and on CI or a
	# locked screen it only lists what is missing.
	can_ask || info "no terminal: switch each permission on in System Settings as it opens; setup moves on by itself"
	if node "$cli_js" permissions grant; then
		ok "every permission is granted"
	else
		warn "some permissions are still missing; finish them any time with: $cua permissions grant"
	fi
fi

# --- 13. Doctor --------------------------------------------------------------------------------------------------

step "doctor"
if ((!run_doctor)); then
	ok "skipped: --no-doctor was given"
	printf '\nopencua is set up in %s.\n' "$repo"
	exit 0
fi
doctor_verdict=ready
if ! node "$cli_js" doctor; then
	# The doctor exits 1 whenever it is not ready; its JSON says whether only the manual permission grants are left.
	doctor_report="$(node "$cli_js" --json doctor 2>/dev/null || true)"
	if node -e '
		try { process.exit(JSON.parse(process.argv[1]).onlyManualStepsRemain === true ? 0 : 1); } catch { process.exit(1); }' \
		"$doctor_report"; then
		doctor_verdict=manual
	else
		doctor_verdict=blocked
	fi
fi

printf '\nNext:\n'
printf '  %-28s %s\n' "$cua config" "optionally restrict apps and choose the MCP clients to register with" \
	"$cua browser setup" "load the unpacked browser extension once and verify the connection" \
	"$cua permissions grant" "walk through the macOS permissions of \"opencua-mcp\"" \
	"$cua history start" "optional: record recent activity, then run permissions grant for Input Monitoring" \
	"$cua doctor --fix" "check the installation and repair what is safe to repair" \
	"$cua update" "update this checkout and everything setup built" \
	"$cua uninstall" "remove opencua again"

case "$doctor_verdict" in
	ready) printf '\nopencua is set up and ready.\n' ;;
	manual)
		printf '\nopencua is set up. One step is left: grant "opencua-mcp" the permissions the doctor lists above.\n'
		printf 'Run %s permissions grant: it shows the dialogs, opens System Settings and waits for each switch.\n' "$cua"
		;;
	*)
		fail "the doctor found problems beyond permissions" \
			"follow the numbered steps the doctor printed above (opencua doctor --fix repairs most), then re-run ./scripts/setup.sh"
		;;
esac
