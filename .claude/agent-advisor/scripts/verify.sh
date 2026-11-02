#!/usr/bin/env bash

# Runs the repo's structural invariant checks in one pass. See the checks
# below; each prints exactly one ok/FAIL line, and a failure in one does not
# stop the rest from running.

set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)

status=0
total=0
failed=0

ok() {
  printf 'ok - %s\n' "$1"
  total=$((total + 1))
}

fail() {
  printf 'FAIL - %s\n' "$1"
  total=$((total + 1))
  failed=$((failed + 1))
  status=1
}

# 1. marketplace.json and plugin.json are valid JSON
detail=$(python3 - "$repo_root" <<'PY'
import json, sys

root = sys.argv[1]
files = [
    f"{root}/.claude-plugin/marketplace.json",
    f"{root}/plugins/agent-advisor/.claude-plugin/plugin.json",
]
errors = []
for path in files:
    try:
        with open(path) as fh:
            json.load(fh)
    except Exception as exc:
        errors.append(f"{path}: {exc}")
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "manifests are valid JSON"
else
  fail "manifests are valid JSON ($detail)"
fi

# 2. marketplace's single plugin entry matches the plugin manifest
detail=$(python3 - "$repo_root" <<'PY'
import json, os, sys

root = sys.argv[1]
errors = []
try:
    with open(f"{root}/.claude-plugin/marketplace.json") as fh:
        marketplace = json.load(fh)
    with open(f"{root}/plugins/agent-advisor/.claude-plugin/plugin.json") as fh:
        plugin = json.load(fh)
    entries = marketplace.get("plugins", [])
    if len(entries) != 1:
        errors.append(f"expected exactly one plugin entry, found {len(entries)}")
    else:
        entry = entries[0]
        source = os.path.normpath(os.path.join(root, entry.get("source", "")))
        if not os.path.exists(source):
            errors.append(f"source does not exist: {entry.get('source')}")
        if entry.get("name") != plugin.get("name"):
            errors.append(
                f"name mismatch: marketplace={entry.get('name')!r} plugin={plugin.get('name')!r}"
            )
except Exception as exc:
    errors.append(str(exc))
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "marketplace plugin entry matches the plugin manifest"
else
  fail "marketplace plugin entry matches the plugin manifest ($detail)"
fi

# 3. every agent has valid frontmatter, a matching name, and an allowed model
detail=$(python3 - "$repo_root" <<'PY'
import glob, os, re, sys

root = sys.argv[1]
agents_dir = os.path.join(root, "plugins/agent-advisor/agents")
allowed_models = {"sonnet", "opus", "haiku", "fable", "inherit"}
errors = []

for path in sorted(glob.glob(os.path.join(agents_dir, "*.md"))):
    rel = os.path.relpath(path, root)
    stem = os.path.splitext(os.path.basename(path))[0]
    with open(path) as fh:
        lines = fh.readlines()
    if not lines or lines[0].strip() != "---":
        errors.append(f"{rel}: missing frontmatter")
        continue
    frontmatter = {}
    terminated = False
    for line in lines[1:]:
        if line.strip() == "---":
            terminated = True
            break
        match = re.match(r'^([A-Za-z_]+):\s*(.*)$', line)
        if match:
            frontmatter[match.group(1)] = match.group(2).strip()
    if not terminated:
        errors.append(f"{rel}: frontmatter not terminated")
        continue
    for key in ("name", "description", "tools", "model"):
        if not frontmatter.get(key):
            errors.append(f"{rel}: missing {key}")
    if frontmatter.get("name") and frontmatter["name"] != stem:
        errors.append(f"{rel}: name {frontmatter['name']!r} != filename stem {stem!r}")
    if frontmatter.get("model") and frontmatter["model"] not in allowed_models:
        errors.append(f"{rel}: model {frontmatter['model']!r} not in {sorted(allowed_models)}")
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "agent frontmatter is well-formed"
else
  fail "agent frontmatter is well-formed ($detail)"
fi

# 4. every skill has valid frontmatter whose name matches its directory
detail=$(python3 - "$repo_root" <<'PY'
import glob, os, re, sys

root = sys.argv[1]
skills_dir = os.path.join(root, "plugins/agent-advisor/skills")
errors = []

for path in sorted(glob.glob(os.path.join(skills_dir, "*/SKILL.md"))):
    rel = os.path.relpath(path, root)
    parent = os.path.basename(os.path.dirname(path))
    with open(path) as fh:
        lines = fh.readlines()
    if not lines or lines[0].strip() != "---":
        errors.append(f"{rel}: missing frontmatter")
        continue
    frontmatter = {}
    terminated = False
    for line in lines[1:]:
        if line.strip() == "---":
            terminated = True
            break
        match = re.match(r'^([A-Za-z_]+):\s*(.*)$', line)
        if match:
            frontmatter[match.group(1)] = match.group(2).strip()
    if not terminated:
        errors.append(f"{rel}: frontmatter not terminated")
        continue
    for key in ("name", "description"):
        if not frontmatter.get(key):
            errors.append(f"{rel}: missing {key}")
    if frontmatter.get("name") and frontmatter["name"] != parent:
        errors.append(f"{rel}: name {frontmatter['name']!r} != directory {parent!r}")
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "skill frontmatter is well-formed"
else
  fail "skill frontmatter is well-formed ($detail)"
fi

# 5. the chair skills defer to the canonical orchestration workflow
detail=""
for chair in opus fable; do
  chair_file="$repo_root/plugins/agent-advisor/skills/$chair/SKILL.md"
  if [ ! -f "$chair_file" ]; then
    detail="${detail}plugins/agent-advisor/skills/$chair/SKILL.md: missing; "
  elif ! grep -q '\.\./orchestration/SKILL\.md' "$chair_file"; then
    detail="${detail}plugins/agent-advisor/skills/$chair/SKILL.md: does not reference ../orchestration/SKILL.md; "
  fi
done
if [ -z "$detail" ]; then
  ok "chair skills defer to ../orchestration/SKILL.md"
else
  fail "chair skills defer to ../orchestration/SKILL.md ($detail)"
fi

# 6. every relative markdown link resolves to a file that exists
detail=$(python3 - "$repo_root" <<'PY'
import os, re, sys

root = sys.argv[1]
link_pattern = re.compile(r'\]\(([^)]+)\)')
errors = []

for dirpath, dirnames, filenames in os.walk(root):
    if ".git" in dirnames:
        dirnames.remove(".git")
    for filename in filenames:
        if not filename.endswith(".md"):
            continue
        path = os.path.join(dirpath, filename)
        rel = os.path.relpath(path, root)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for match in link_pattern.finditer(text):
            target = match.group(1).strip().split()[0] if match.group(1).strip() else ""
            if not target or target.startswith("#"):
                continue
            if target.startswith("http://") or target.startswith("https://"):
                continue
            link_path = target.split("#", 1)[0]
            if not link_path:
                continue
            resolved = os.path.normpath(os.path.join(dirpath, link_path))
            if not os.path.exists(resolved):
                errors.append(f"{rel}: broken link {target}")
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "relative markdown links resolve"
else
  fail "relative markdown links resolve ($detail)"
fi

# 7. every subagent_type is plugin-namespaced and resolves to a defined agent
detail=$(python3 - "$repo_root" <<'PY'
import glob, os, re, sys

root = sys.argv[1]
agents_dir = os.path.join(root, "plugins/agent-advisor/agents")
skills_dir = os.path.join(root, "plugins/agent-advisor/skills")

defined = {
    os.path.splitext(os.path.basename(p))[0]
    for p in glob.glob(os.path.join(agents_dir, "*.md"))
}

# A bare agent name fails at spawn as "agent type not found", which is
# indistinguishable from an unregistered lane. Catch it here instead.
pattern = re.compile(r'subagent_type:\s*([^\s`]+)')
problems = []
for dirpath, _, filenames in os.walk(skills_dir):
    for filename in filenames:
        path = os.path.join(dirpath, filename)
        with open(path, encoding="utf-8") as fh:
            for value in pattern.findall(fh.read()):
                rel = os.path.relpath(path, root)
                if ":" not in value:
                    problems.append(f"{rel}: subagent_type {value} is not plugin-namespaced")
                    continue
                prefix, name = value.split(":", 1)
                if prefix != "agent-advisor":
                    problems.append(f"{rel}: subagent_type {value} has wrong plugin prefix")
                elif name not in defined:
                    problems.append(f"{rel}: subagent_type {value} names no defined agent")

print("; ".join(problems))
PY
)
if [ -z "$detail" ]; then
  ok "every subagent_type is namespaced and defined"
else
  fail "every subagent_type is namespaced and defined ($detail)"
fi

# 8. the out-of-process review lane is present and pins everything that matters
detail=$(python3 - "$repo_root" <<'PY'
import os, sys

root = sys.argv[1]
rel = "plugins/agent-advisor/scripts/review-codex.sh"
path = os.path.join(root, rel)
errors = []

if not os.path.isfile(path):
    errors.append(f"{rel}: missing")
elif not os.access(path, os.X_OK):
    errors.append(f"{rel}: not executable")
else:
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
    # The script's own comments name these flags, so a whole-file search would be
    # satisfied by the comment while the real argument had been deleted. Search only
    # lines that actually execute.
    text = "\n".join(l for l in raw.splitlines() if not l.lstrip().startswith("#"))
    # A review lane that inherits the user's config is not a pinned lane: the model
    # can be retargeted outside the repo without anything here changing.
    required = {
        "--ignore-user-config": "does not pass --ignore-user-config",
        "project_doc_max_bytes=0": "does not suppress the reviewed repo's AGENTS.md",
        "--ignore-rules": "does not pass --ignore-rules",
        '--cd "$work_abs"': "does not run from a neutral working directory",
        "PIN_MODEL=": "does not pin a model",
        "PIN_EFFORT=": "does not pin a reasoning effort",
        "PIN_SANDBOX=": "does not pin a sandbox mode",
    }
    for needle, complaint in required.items():
        if needle not in text:
            errors.append(f"{rel}: {complaint}")
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "out-of-process review lane is pinned"
else
  fail "out-of-process review lane is pinned ($detail)"
fi

# 9. no chair falls back to a reviewer pinned to that chair's own model
detail=$(python3 - "$repo_root" <<'PY'
import glob, os, re, sys

root = sys.argv[1]
agents_dir = os.path.join(root, "plugins/agent-advisor/agents")
skills_dir = os.path.join(root, "plugins/agent-advisor/skills")

pins = {}
for path in glob.glob(os.path.join(agents_dir, "*.md")):
    stem = os.path.splitext(os.path.basename(path))[0]
    with open(path, encoding="utf-8") as fh:
        match = re.search(r'^model:\s*(\S+)\s*$', fh.read(), re.M)
    if match:
        pins[stem] = match.group(1)

# The chair names its own model in prose; map that onto the agent model aliases.
aliases = ("opus", "fable", "sonnet", "haiku")
errors = []

for chair_file in sorted(glob.glob(os.path.join(skills_dir, "*/SKILL.md"))):
    with open(chair_file, encoding="utf-8") as fh:
        text = fh.read()
    chair = re.search(r'^chair:\s*(.+)$', text, re.M)
    # The canonical workflow carries `chair: <the chair's model>` as a template, not
    # as a declaration. A real chair states a literal; a placeholder is not one.
    if not chair or chair.group(1).strip().startswith("<"):
        continue  # not a chair skill
    rel = os.path.relpath(chair_file, root)
    failover = re.search(r'^failover:\s*(\S+)\s*$', text, re.M)
    if not failover:
        errors.append(f"{rel}: declares a chair but no failover")
        continue
    lane = failover.group(1).split(":", 1)[-1]
    if lane not in pins:
        errors.append(f"{rel}: failover {failover.group(1)} names no defined agent")
        continue
    chair_model = next((a for a in aliases if a in chair.group(1).lower()), None)
    if chair_model and pins[lane] == chair_model:
        errors.append(
            f"{rel}: failover {lane} is pinned to {pins[lane]}, the chair's own model"
        )
print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "no chair fails over to its own model"
else
  fail "no chair fails over to its own model ($detail)"
fi

# 10. the structural isolation properties actually hold in the agent definitions
detail=$(python3 - "$repo_root" <<'PY'
import glob, os, re, sys

root = sys.argv[1]
agents_dir = os.path.join(root, "plugins/agent-advisor/agents")

# These are the two guarantees the README describes as structural rather than advisory.
# Both are enforced by an ABSENCE in the tools list, which is the easiest kind of
# guarantee to revoke by accident: adding a tool for an unrelated reason silently
# removes it, and nothing about the diff looks wrong.
MUTATING = {"Write", "Edit", "NotebookEdit", "Bash", "BashOutput", "KillShell"}
errors = []

for path in sorted(glob.glob(os.path.join(agents_dir, "*.md"))):
    rel = os.path.relpath(path, root)
    stem = os.path.splitext(os.path.basename(path))[0]
    with open(path, encoding="utf-8") as fh:
        parts = fh.read().split("---", 2)
    if len(parts) < 3:
        errors.append(f"{rel}: unreadable frontmatter")
        continue
    match = re.search(r'^tools:\s*(.+)$', parts[1], re.M)
    if not match:
        errors.append(f"{rel}: no tools list")
        continue
    tools = {tool.strip() for tool in match.group(1).split(",") if tool.strip()}

    if stem.startswith("reviewer"):
        leaked = sorted(tools & MUTATING)
        if leaked:
            errors.append(f"{rel}: reviewer holds mutating tools {leaked}")
    if stem.startswith("implementer") and "Agent" in tools:
        errors.append(f"{rel}: implementer holds the Agent tool")

print("; ".join(errors))
PY
)
if [ -z "$detail" ]; then
  ok "reviewer read-only and implementer no-delegation isolation hold"
else
  fail "reviewer read-only and implementer no-delegation isolation hold ($detail)"
fi

if [ "$failed" -eq 0 ]; then
  printf 'summary: %d/%d checks passed\n' "$total" "$total"
else
  printf 'summary: %d/%d checks passed, %d failed\n' "$((total - failed))" "$total" "$failed"
fi

exit "$status"
