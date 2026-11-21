#!/usr/bin/env python3
"""dump-cmd-topic2.py — dump-log 全量捕获 + offset/iscontrol 解析。一次性诊断。"""

import json
import subprocess
import tempfile
import os
import re

pw = json.load(open("C:/Users/51293/bin/hosts.json", encoding="utf-8"))["hosts"]["tencent-server"]["password"]
LOG = "/var/lib/kafka/data/_confluent-ksql-ksql-explorer-01_command_topic-0/00000000000000000000.log"
dump = "docker exec kafka /opt/kafka/bin/kafka-dump-log.sh --files " + LOG + " --print-data-log"

script = "\n".join([
    "import paramiko, sys",
    "ssh = paramiko.SSHClient()",
    "ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())",
    'ssh.connect("110.40.185.78", username="root", password=' + json.dumps(pw) + ', timeout=10)',
    "_, o, _ = ssh.exec_command(" + json.dumps(dump) + ", timeout=120)",
    "out = o.read().decode('utf-8','replace')",
    "print('OUT-LEN:', len(out))",
    "import re",
    "for line in out.splitlines():",
    "    m = re.search(r'offset: (\\d+).*?iscontrol: (\\w+)', line)",
    "    if m:",
    "        print('offset', m.group(1), '| iscontrol', m.group(2))",
    "print('--- first 10 raw lines ---')",
    "print(chr(10).join(out.splitlines()[:10]))",
    "ssh.close()",
])

f = os.path.join(tempfile.gettempdir(), "dump-cmd-topic2.py")
open(f, "w", encoding="utf-8").write(script)
r = subprocess.run(["python", f], shell=True, capture_output=True, text=True, timeout=300)
print(r.stdout)
if r.returncode:
    print("ERR:", r.stderr[-200:])
