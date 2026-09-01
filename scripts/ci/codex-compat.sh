#!/usr/bin/env bash
set -euo pipefail

# ISS-834 C4: ported from ~/Developer/Probe/scripts/ci/codex-compat.sh
# (see plan-run10.md R5#4), with one addition Probe's own script lacks:
# a payload-content assertion. Probe (b) (plan-run10.md R3) showed that
# `codex plugin add` / `plugin list --json` can report a fully successful
# install while `skills/story/` is silently empty underneath -- the
# metadata-only assertions below would not have caught that. CI-only /
# local-only: shells out to a real `codex` binary and performs a real
# install, unsuitable for the default vitest suite.

codex_version="${1:?usage: codex-compat.sh <codex-version>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

codex_cli() {
  npx --yes "@openai/codex@$codex_version" "$@"
}

test "$(codex_cli --version)" = "codex-cli $codex_version"

marketplace_list="$(codex_cli plugin marketplace list --json)"
if ! python3 -c '
import json
import os
import sys

marketplaces = json.loads(sys.argv[1]).get("marketplaces", [])
expected_root = os.path.realpath(sys.argv[2])
assert any(os.path.realpath(item.get("root", "")) == expected_root for item in marketplaces)
' "$marketplace_list" "$repo_root"; then
  codex_cli plugin marketplace add "$repo_root"
fi

codex_cli plugin add storybloq@storybloq
plugin_list="$(codex_cli plugin list --json)"
plugin_version="$(python3 -c '
import json
import os
import sys

payload = json.loads(sys.argv[1])
matches = [
    item
    for item in payload.get("installed", [])
    if item.get("pluginId") == "storybloq@storybloq"
]
assert len(matches) == 1, matches
plugin = matches[0]
assert plugin.get("enabled") is True, plugin
assert plugin.get("marketplaceName") == "storybloq", plugin
expected_source = os.path.realpath(os.path.join(sys.argv[2], "plugins", "storybloq"))
assert os.path.realpath(plugin["source"]["path"]) == expected_source, plugin
print(plugin["version"])
' "$plugin_list" "$repo_root")"

# Payload-content assertion (the addition over Probe's script): resolve the
# real installed cache path and assert the skill content actually matches
# src/skill/, not just that the manifests report success.
codex_home="${CODEX_HOME:-$HOME/.codex}"
installed_skill_dir="$codex_home/plugins/cache/storybloq/storybloq/$plugin_version/skills/story"
npx --yes tsx "$repo_root/scripts/ci/assert-skill-payload.ts" "$repo_root/src/skill" "$installed_skill_dir"
