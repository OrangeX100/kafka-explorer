# Sidebar dot semantics keys (idempotent).
import io, json

ZH = {
    "conn.statusConnected": "已连接 · 探活正常",
    "conn.statusFailed": "会话已打开，但 Broker 探活失败（无法连接）",
    "conn.statusProbing": "探活中…",
    "conn.statusDisconnected": "未打开会话",
}
EN = {
    "conn.statusConnected": "Connected · probe OK",
    "conn.statusFailed": "Session open, but broker probe failed (unreachable)",
    "conn.statusProbing": "Probing…",
    "conn.statusDisconnected": "No session",
}

for name, keys in (("zh-CN", ZH), ("en", EN)):
    path = f"frontend/src/shared/locales/{name}.json"
    with io.open(path, encoding="utf-8") as f:
        data = json.load(f)
    added = 0
    for k, v in keys.items():
        if k not in data:
            data[k] = v
            added += 1
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{name}: +{added} -> {len(data)}")
