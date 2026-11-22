"""Release 后同步到 Gitee release（人肉手动下载镜像）。

Gitee 附件下载强制登录（2026-11-22 实证）——这不是更新器的源，
是发布页人肉下载的备用通道。env: GITHUB_REF_NAME / GITEE_TOKEN
（Actions secret）。cwd 必须是仓库根。
"""
import json
import os
import urllib.request

ver = os.environ["GITHUB_REF_NAME"].lstrip("v")
tok = os.environ["GITEE_TOKEN"]
base = "https://gitee.com/api/v5/repos/OrangeX100/kafka-explorer"
q = f"access_token={tok}"


def api(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except Exception as e:  # noqa: BLE001 — 统一降级为可读错误
        return {"_err": str(e)}


rel = api(f"{base}/releases/tags/v{ver}?{q}")
if "id" not in rel:
    body = json.dumps({
        "access_token": tok, "tag_name": f"v{ver}",
        "name": f"Kafka Explorer {ver}", "target_commitish": "master",
        "body": f"Kafka Explorer {ver} — 详见 GitHub Release 与仓库 README。",
    })
    rel = api(f"{base}/releases", data=body.encode(),
              headers={"Content-Type": "application/json"})
rid = rel["id"]
print("release id:", rid)

CRLF = chr(13) + chr(10)
for f in [f"KafkaExplorer_Setup_{ver}.exe",
          f"KafkaExplorer_Setup_{ver}.exe.sha256", "latest.json"]:
    with open(os.path.join("bin", "installer", f), "rb") as fh:
        data = fh.read()
    boundary = "----keb"
    part = (
        f"--{boundary}{CRLF}"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"{f}\"{CRLF}"
        f"Content-Type: application/octet-stream{CRLF}{CRLF}"
    ).encode() + data + f"{CRLF}--{boundary}--{CRLF}".encode()
    req = urllib.request.Request(
        f"{base}/releases/{rid}/attach_files?{q}", data=part,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    print(f, urllib.request.urlopen(req, timeout=300).status)
