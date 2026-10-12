#!/bin/sh
# Runs `kustomad hook <event>` from this plugin with the hook input on stdin.
#
# At session start it also puts the plugin's bin/ on the PATH of the agent's shell (through
# $CLAUDE_ENV_FILE), so the agent can type `kustomad show …`. The Bash hook stays
# cheap: commands that neither open a file nor merge/commit pass without starting Node.

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
event="$1"
input="$(cat)"

if [ "$event" = "session-start" ] && [ -n "$CLAUDE_ENV_FILE" ]; then
	printf 'export PATH="%s/bin:$PATH"\n' "$root" >>"$CLAUDE_ENV_FILE"
fi

if ! command -v node >/dev/null 2>&1; then
	if [ "$event" = "session-start" ]; then
		echo "KustomAD (a review page for what you make) is installed but needs Node.js 22.6+, and node is not on PATH; tell the user if they expect it."
	fi
	exit 0
fi

if [ "$event" = "pre-tool-use" ]; then
	case "$input" in
		*open*|*eog*|*feh*|*sxiv*|*imv*|*loupe*|*gwenview*|*ristretto*|*display*|*mpv*|*vlc*|*totem*|*celluloid*|*ffplay*|*mplayer*|*qlmanage*|*f3d*|*evince*|*okular*|*zathura*|*firefox*|*chrom*|*brave*|*edge*|*safari*|*thumb*|*shotwell*) ;;
		*git*merge*|*git*commit*|*git*pull*) ;;
		*) exit 0 ;;
	esac
fi

printf '%s' "$input" | exec sh "$root/bin/kustomad" hook "$event"
