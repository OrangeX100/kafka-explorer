"""Release 后同步安装包到腾讯服务器 nginx 镜像（国内下载源）。

env: GITHUB_REF_NAME / CN_SSH_HOST / CN_SSH_PORT / CN_SSH_USER /
CN_SSH_PASSWORD（Actions secret）。cwd 必须是仓库根——资产在
bin/installer/ 下。2026-11-22：公共加速器仅 1/9 存活，自建国内源。

2026-11-22 评审 P2-3：直传最终路径 + 哈希只打印不比对，会让 SSH 抖动在
nginx 目录里留下半个文件——updater 的国内通道对该版本持续 SHA 校验失败。
现在三步走：先传 `.part`，服务端 sha256sum 与本地一致后 posix_rename 原子
替换（rename 保证 nginx 永远只看到完整文件），外层重试 3 次。
"""
import hashlib
import os
import time

import paramiko

REMOTE_DIR = "/var/www/kafka-explorer/releases"
RETRIES = 3


def local_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ver = os.environ["GITHUB_REF_NAME"].lstrip("v")
    host = os.environ["CN_SSH_HOST"]
    port = int(os.environ["CN_SSH_PORT"])
    files = [
        f"KafkaExplorer_Setup_{ver}.exe",
        f"KafkaExplorer_Setup_{ver}.exe.sha256",
        "latest.json",
    ]
    digests = {f: local_sha256(os.path.join("bin", "installer", f)) for f in files}

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, port=port, username=os.environ["CN_SSH_USER"],
                password=os.environ["CN_SSH_PASSWORD"], timeout=20)
    run = lambda c: ssh.exec_command(c, timeout=120)[1].read().decode()
    print("mkdir:", run(f"mkdir -p {REMOTE_DIR}"))

    for f in files:
        local = os.path.join("bin", "installer", f)
        remote = f"{REMOTE_DIR}/{f}"
        part = remote + ".part"
        for attempt in range(1, RETRIES + 1):
            try:
                # 每次尝试重建连接（0.4.21 评审 P2-4）：为 SSH 抖动而生的
                # 重试曾把 3 轮全耗在已被重置的 transport 上秒抛
                try:
                    ssh.close()
                except Exception:  # noqa: BLE001
                    pass
                ssh = paramiko.SSHClient()
                ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                ssh.connect(host, port=port, username=os.environ["CN_SSH_USER"],
                            password=os.environ["CN_SSH_PASSWORD"], timeout=20)
                run_local = lambda c: ssh.exec_command(c, timeout=120)[1].read().decode()
                sftp = ssh.open_sftp()
                try:
                    sftp.put(local, part)
                    out = run_local(f"sha256sum {part}").split()
                    if not out or out[0] != digests[f]:
                        raise RuntimeError(
                            f"server hash mismatch: got {out[:1]} want {digests[f]}")
                    # 原子替换：rename(2) 同目录原子生效，nginx 不会读到半包
                    sftp.posix_rename(part, remote)
                finally:
                    sftp.close()
                print("uploaded+verified", f)
                break
            except Exception as e:  # noqa: BLE001 —— 重试后由最后一轮决定成败
                if attempt == RETRIES:
                    raise
                print(f"retry {attempt}/{RETRIES} for {f}: {e}")
                time.sleep(2 * attempt)
    # 兜底清扫：历史遗留或中断留下的 .part（本次已不存在则无操作）——
    # 用最后一次重建的连接（外层 run lambda 指向首连，可能已死）
    run_final = lambda c: ssh.exec_command(c, timeout=120)[1].read().decode()  # noqa: E731
    print("cleanup:", run_final(f"rm -f {REMOTE_DIR}/*.part"))
    ssh.close()


if __name__ == "__main__":
    main()
