# Overwrite reg.testOk wording (id-based display now carries version or mode).
import io, json

UPDATES = {
    "zh-CN": {"reg.testOk": "连接成功 · {0}"},
    "en": {"reg.testOk": "Connected · {0}"},
}

for name, updates in UPDATES.items():
    path = f"frontend/src/shared/locales/{name}.json"
    with io.open(path, encoding="utf-8") as f:
        data = json.load(f)
    for k, v in updates.items():
        data[k] = v
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(name, "updated")
