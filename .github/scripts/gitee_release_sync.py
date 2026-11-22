"""Release 后同步到 Gitee release（人肉手动下载镜像）。

Gitee 附件下载强制登录（2026-11-22 实证）——这不是更新器的源，
是发布页人肉下载的备用通道。env: GITHUB_REF_NAME / GITEE_TOKEN
（Actions secret）。cwd 必须是仓库根。

2026-11-23 重试加固：v0.4.20 实测 50MB 附件上传 write-timeout 直接失败
（continue-on-error 放行，Gitee 版本缺位直到手补）。三处：
- 每次附件尝试重建（附件上传超时不代表整个会话坏，但 Gitee 偶发断连——
  简单起见每个附件独立请求，天然无共享会话）；
- 每附件 3 次重试 + 退避；
- 附件成功后按 GitHub Release 的正文 PATCH 中文说明（Gitee PATCH 只认
  form-urlencoded，不认 JSON body——400 "body is missing" 实证）。
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

ver = os.environ["GITHUB_REF_NAME"].lstrip("v")
tok = os.environ["GITEE_TOKEN"]
base = "https://gitee.com/api/v5/repos/OrangeX100/kafka-explorer"
q = f"access_token={tok}"
RETRIES = 3


def api(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        raw = urllib.request.urlopen(req, timeout=120).read()
        # Gitee 对不存在的 tag 返回字面量 null 体（2026-11-22 实证）——
        # 归一为 {} 走创建路径
        parsed = json.loads(raw) if raw.strip() else None
        return parsed if isinstance(parsed, dict) else {}
    except Exception as e:  # noqa: BLE001 — 统一降级为可读错误
        return {"_err": str(e)}


def with_retries(label, fn):
    for attempt in range(1, RETRIES + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            if attempt == RETRIES:
                raise
            print(f"retry {attempt}/{RETRIES} for {label}: {e}")
            time.sleep(2 * attempt)


rel = api(f"{base}/releases/tags/v{ver}?{q}")
if not isinstance(rel, dict) or "id" not in rel:
    body = json.dumps({
        "access_token": tok, "tag_name": f"v{ver}",
        "name": f"Kafka Explorer {ver}", "target_commitish": "master",
        "body": f"Kafka Explorer {ver} — 详见 GitHub Release 与仓库 README。",
    })
    rel = with_retries("create release",
                       lambda: api(f"{base}/releases", data=body.encode(),
                                   headers={"Content-Type": "application/json"}))
rid = rel.get("id")
if not rid:
    raise SystemExit(f"Gitee release 创建/查询失败: {rel}")
print("release id:", rid)

CRLF = chr(13) + chr(10)
for f in [f"KafkaExplorer_Setup_{ver}.exe",
          f"KafkaExplorer_Setup_{ver}.exe.sha256", "latest.json"]:
    with open(os.path.join("bin", "installer", f), "rb") as fh:
        data = fh.read()

    def upload(f=f, data=data):
        boundary = "----keb"
        part = (
            f"--{boundary}{CRLF}"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{f}\"{CRLF}"
            f"Content-Type: application/octet-stream{CRLF}{CRLF}"
        ).encode() + data + f"{CRLF}--{boundary}--{CRLF}".encode()
        req = urllib.request.Request(
            f"{base}/releases/{rid}/attach_files?{q}", data=part,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        return urllib.request.urlopen(req, timeout=600).status

    print(f, with_retries(f"upload {f}", upload))

# 正文对齐 GitHub Release：gh token（secrets.GH_TOKEN）读 GH 端 release
# 正文（发布说明在 release job 里已被中文化），form PATCH 到 Gitee——
# Gitee PATCH 只认 form-urlencoded，不认 JSON body（400 "body is missing"
# 实证 2026-11-23）。GH_TOKEN 缺失时跳过（本地手动补）。
gh_tok = os.environ.get("GH_TOKEN", "")
if gh_tok:
    def patch_body():
        req = urllib.request.Request(
            f"https://api.github.com/repos/OrangeX100/kafka-explorer/releases/tags/v{ver}",
            headers={"Authorization": f"Bearer {gh_tok}",
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            gh_rel = json.load(r)
        form = urllib.parse.urlencode({
            "access_token": tok, "tag_name": f"v{ver}",
            "name": gh_rel.get("name") or f"Kafka Explorer {ver}",
            "body": gh_rel.get("body") or "",
        }).encode()
        req2 = urllib.request.Request(
            f"{base}/releases/{rid}",
            data=form, headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="PATCH")
        return urllib.request.urlopen(req2, timeout=120).status
    print("body patch:", with_retries("patch body", patch_body))
print("gitee release synced:", rid)
