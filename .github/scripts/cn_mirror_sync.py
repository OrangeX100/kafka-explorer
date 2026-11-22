"""Release 后同步安装包到腾讯服务器 nginx 镜像（国内下载源）。

env: GITHUB_REF_NAME / CN_SSH_HOST / CN_SSH_PORT / CN_SSH_USER /
CN_SSH_PASSWORD（Actions secret）。cwd 必须是仓库根——资产在
bin/installer/ 下。2026-11-22：公共加速器仅 1/9 存活，自建国内源。
"""
import os

import paramiko

ver = os.environ["GITHUB_REF_NAME"].lstrip("v")
host = os.environ["CN_SSH_HOST"]
port = int(os.environ["CN_SSH_PORT"])
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=port, username=os.environ["CN_SSH_USER"],
            password=os.environ["CN_SSH_PASSWORD"], timeout=20)
run = lambda c: ssh.exec_command(c, timeout=120)[1].read().decode()
print("mkdir:", run("mkdir -p /var/www/kafka-explorer/releases"))
sftp = ssh.open_sftp()
for f in [f"KafkaExplorer_Setup_{ver}.exe",
          f"KafkaExplorer_Setup_{ver}.exe.sha256", "latest.json"]:
    local = os.path.join("bin", "installer", f)
    sftp.put(local, f"/var/www/kafka-explorer/releases/{f}")
    print("uploaded", f)
sftp.close()
print("hash:", run(f"sha256sum /var/www/kafka-explorer/releases/KafkaExplorer_Setup_{ver}.exe"))
ssh.close()
