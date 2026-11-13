# Syncs build/versioninfo.json with the version stamped for this build.
# The exe's VERSIONINFO resource (FileDescription/ProductVersion/...) is the
# single biggest code-side lever against AV false positives: an unsigned
# GUI binary with NO file description is a heuristic high-scorer for 360 &
# friends and has been cloud-quarantined on the dev box.
#
# Usage: python scripts/sync_versioninfo.py <version>   e.g. 0.1.0-dev
# Called by the Taskfile build task; a plain `go build` uses the committed
# app_windows_version.syso, so this only needs to run when VERSION changes.
import json
import re
import sys

TEMPLATE = "build/versioninfo.json"


def fail(msg):
    print(f"sync_versioninfo: {msg}", file=sys.stderr)
    sys.exit(2)


def main():
    if len(sys.argv) != 2:
        fail("usage: sync_versioninfo.py <version>")
    version = sys.argv[1].strip()
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-(.+))?", version)
    if not m:
        fail(f"version {version!r} is not semver-ish (major.minor.micro[-suffix])")

    with open(TEMPLATE, encoding="utf-8") as f:
        data = json.load(f)

    # beta.N carries its sequence in the numeric Build field (0.2.0-beta.1
    # → 0.2.0.1) so Explorer's 版本 column orders prereleases sensibly.
    patch = int(m.group(4).split(".")[1]) if m.group(4) and re.match(r"beta\.(\d+)$", m.group(4)) else 0
    parts = [int(m.group(1)), int(m.group(2)), int(m.group(3)), patch]
    # goversioninfo's FileVersion struct is {Major, Minor, Patch, Build} —
    # the old "Micro" key decoded into NOTHING, so the numeric version was
    # always x.y.0.0 (the "FixedFileInfo.FileVersion (0.4.0.0) and
    # StringFileInfo.FileVersion do not match" warning on every build, and a
    # stale numeric version in Explorer's 属性 page).
    data["FixedFileInfo"]["FileVersion"] = dict(zip(("Major", "Minor", "Patch", "Build"), parts))
    data["FixedFileInfo"]["ProductVersion"] = dict(zip(("Major", "Minor", "Patch", "Build"), parts))
    s = data["StringFileInfo"]
    s["FileVersion"] = version
    s["ProductVersion"] = version
    comments = s.get("Comments", "")
    # keep commit out of the strings here: it changes every build and would
    # dirty the syso on every commit; the About page reads buildinfo ldflags.
    if comments and comments not in (
        "Kafka cluster explorer: topics, messages and consumer groups",
    ):
        fail("unexpected Comments field — check the template was not hand-edited")

    with open(TEMPLATE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"sync_versioninfo: versioninfo.json -> {version}")


main()
