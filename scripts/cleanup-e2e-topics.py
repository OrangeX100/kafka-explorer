#!/usr/bin/env python3
"""cleanup-e2e-topics.py — 清理共享测试集群上历次探针泄漏的 e2e-* 主题。

泄漏路径：afterAll 的 UI 删主题在 keep-mounted 隐藏面板下被幂等守卫跳过。
主题堆积超过列表单页 50 条后，新主题按名字排序落到第二页——createTopic
的 DOM 断言找不到它（2026-11-21 goto flake 的根因）。

用法：python scripts/cleanup-e2e-topics.py [--dry-run]
"""

import json
import os
import subprocess
import sys
import tempfile

HOSTS = "C:/Users/51293/bin/hosts.json"


def ssh(cmd: str) -> str:
    hosts = json.load(open(HOSTS, encoding="utf-8"))["hosts"]["tencent-server"]
    pw = hosts["password"]
    # host/user 也从 hosts.json 读——公仓库不再明文携带地址（0.4.21 P2-2）
    host = hosts.get("host", "")
    user = hosts.get("user", "")
    script = "\n".join([
        "import paramiko, sys",
        "ssh = paramiko.SSHClient()",
        "ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())",
        "ssh.connect(" + json.dumps(host) + ", username=" + json.dumps(user) + ", password=" + json.dumps(pw) + ", timeout=10)",
        "_, o, _ = ssh.exec_command(" + json.dumps(cmd) + ", timeout=120)",
        "sys.stdout.write(o.read().decode('utf-8','replace'))",
        "ssh.close()",
    ])
    f = os.path.join(tempfile.gettempdir(), "ke-cleanup-topics.py")
    open(f, "w", encoding="utf-8").write(script)
    r = subprocess.run(["python", f], shell=True, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:300])
    return r.stdout


def main() -> None:
    dry = "--dry-run" in sys.argv
    out = ssh(
        "docker exec kafka /opt/kafka/bin/kafka-topics.sh "
        "--bootstrap-server localhost:9096 --list"
    )
    topics = sorted(t.strip() for t in out.splitlines() if t.strip().startswith("e2e-"))
    print(f"e2e-* 主题共 {len(topics)} 个")
    if dry:
        for t in topics:
            print("  [dry]", t)
        return
    deleted = 0
    for t in topics:
        r = ssh(
            "docker exec kafka /opt/kafka/bin/kafka-topics.sh "
            f"--bootstrap-server localhost:9096 --delete --topic {t}"
        )
        deleted += 1
        if deleted % 10 == 0:
            print(f"  已删 {deleted}/{len(topics)}")
    print(f"完成：删除 {deleted} 个泄漏主题")


if __name__ == "__main__":
    main()
