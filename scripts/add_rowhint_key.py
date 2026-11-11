# Row hint key (idempotent).
import io, json

ZH = {"conn.rowHint": "双击打开连接"}
EN = {"conn.rowHint": "Double-click to connect"}

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
