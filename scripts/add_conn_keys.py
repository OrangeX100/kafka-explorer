# Insert connection-module review round keys (idempotent).
import io, json

ZH = {
    "conn.tlsClientCert": "客户端证书路径（mTLS）",
    "conn.tlsClientKey": "客户端私钥路径",
    "conn.pickCert": "选择证书文件",
    "conn.exportTitle": "导出连接",
    "conn.importTitle": "导入连接",
    "conn.importPick": "选择连接导出文件",
    "conn.exportOk": "连接已导出到所选文件（不含密码）",
    "conn.importOk": "已导入 {0} 条连接",
    "conn.importNeedPw": "已导入 {0} 条连接；{1} 条 SASL 连接需在编辑中补密码",
    "conn.pin": "置顶（收藏）",
    "conn.unpin": "取消置顶",
}

EN = {
    "conn.tlsClientCert": "Client certificate path (mTLS)",
    "conn.tlsClientKey": "Client key path",
    "conn.pickCert": "Pick certificate file",
    "conn.exportTitle": "Export connections",
    "conn.importTitle": "Import connections",
    "conn.importPick": "Pick an exported connections file",
    "conn.exportOk": "Connections exported to the chosen file (no passwords)",
    "conn.importOk": "Imported {0} connections",
    "conn.importNeedPw": "Imported {0} connections; {1} SASL entries need a password — edit to set it",
    "conn.pin": "Pin to top",
    "conn.unpin": "Unpin",
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
