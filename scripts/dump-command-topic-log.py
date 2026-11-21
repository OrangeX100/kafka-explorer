#!/usr/bin/env python3
"""dump-command-topic-log.py — 读取 ksql 命令主题 P0 的 segment 日志，
确认 offset 1 是事务控制记录（对消费者不可见）。诊断脚本，一次性。"""

import json
import subprocess
import tempfile
import os

pw = json.load(open("C:/Users/51293/bin/hosts.json", encoding="utf-8"))["hosts"]["tencent-server"]["password"]
D = "/var/lib/kafka/data/_confluent-ksql-ksql-explorer-01_command_topic-0"
LOG = D + "/00000000000000000000.log"

ls_cmd = "docker exec kafka ls " + D
dump_cmd = "docker exec kafka /opt/kafka/bin/kafka-dump-log.sh --files " + LOG + " --print-data-log"

script = "\n".join([
    "import paramiko, sys",
    "ssh = paramiko.SSHClient()",
    "ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())",
    'ssh.connect("110.40.185.78", username="root", password=' + json.dumps(pw) + ', timeout=10)',
    "_, o, _ = ssh.exec_command(" + json.dumps(ls_cmd) + ", timeout=60)",
    'print("files:", o.read().decode("utf-8","replace").strip()[:300])',
    "_, o, _ = ssh.exec_command(" + json.dumps(dump_cmd + " 2>/dev/null | head -24") + ", timeout=120)",
    'print(o.read().decode("utf-8","replace"))',
    "ssh.close()",
])

f = os.path.join(tempfile.gettempdir(), "dump-cmd-topic.py")
open(f, "w", encoding="utf-8").write(script)
r = subprocess.run(["python", f], shell=True, capture_output=True, text=True, timeout=300)
print(r.stdout[-2200:])
if r.returncode:
    print("ERR:", r.stderr[-200:])
