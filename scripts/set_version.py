#!/usr/bin/env python3
"""set_version.py <version> — 一键把发布版本写到所有手工维护的位置。

解决的痛点：发布前要人肉追改 Taskfile 两处默认值 + frontend/package.json
（十次发布里每次都要 sed 三四个文件，漏一处就是"版本号不一致"事故）。
versioninfo.json / uninstaller-versioninfo.json / app_windows.syso 由
Taskfile build 任务自动重新生成，无需在此处理。

用法：python scripts/set_version.py 0.4.10
校验：version_contract_test.go 会在门禁里钉死所有位置的一致性。
"""
import json
import re
import subprocess
import sys

if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
    print("用法: python scripts/set_version.py <major.minor.patch>")
    sys.exit(1)

version = sys.argv[1]

# 1. Taskfile：build/installer 两个任务的默认 VERSION/VERSIONINFOVERSION
#    + sign 任务的 -Exe 路径内的硬编码版本。用正则替换任意旧版本号，
#    不依赖具体旧值——新位置出现时只要 default "x.y.z" 形态就自动命中。
s = open("Taskfile.yml", encoding="utf-8").read()
s, n1 = re.subn(
    r"(VERSION: '\{\{\.VERSION \| default \")\d+\.\d+\.\d+(\"\}\}')",
    rf"\g<1>{version}\g<2>",
    s,
)
s, n2 = re.subn(
    r"(VERSIONINFOVERSION: '\{\{\.VERSIONINFOVERSION \| default \")\d+\.\d+\.\d+\.0(\"\}\}')",
    rf"\g<1>{version}.0\g<2>",
    s,
)
# sign 任务的 -Exe 路径里的硬编码版本（如 KafkaExplorer_Setup_0.4.10.exe）
s, n3 = re.subn(
    r"(KafkaExplorer_Setup_)\d+\.\d+\.\d+(\.exe)",
    rf"\g<1>{version}\g<2>",
    s,
)
open("Taskfile.yml", "w", encoding="utf-8", newline="").write(s)
print(f"Taskfile: {n1} 处 VERSION + {n2} 处 VERSIONINFOVERSION + {n3} 处 -Exe 路径")

# 2. frontend/package.json
pkg_path = "frontend/package.json"
pkg = json.load(open(pkg_path, encoding="utf-8"))
pkg["version"] = version
open(pkg_path, "w", encoding="utf-8", newline="").write(
    json.dumps(pkg, ensure_ascii=False, indent=2) + "\n"
)
print("package.json: version")

# 3. versioninfo.json（字符串版本；数值版本 build 时由 sync_versioninfo.py
#    重新生成——这里同步执行保证本地 versioninfo.json 不漂移）
r = subprocess.run(
    [sys.executable, "scripts/sync_versioninfo.py", version],
    capture_output=True, text=True,
)
print(r.stdout.strip())
if r.returncode != 0:
    print(r.stderr)
    sys.exit(1)

print(f"版本号已全部写入: {version}（用 git diff 复核后随版提交）")
