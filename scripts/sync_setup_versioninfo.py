# Stamps build/setup-versioninfo.json with the current version for
# goversioninfo (the custom setup front-end exe's PE metadata — an unsigned
# binary without FileDescription is a 360 heuristic high-scorer).
# Usage: python scripts/sync_setup_versioninfo.py 0.2.0-beta.1
import io
import json
import sys

VERSION = sys.argv[1]

OUT = "build/setup-versioninfo.json"

meta = {
    "StringFileInfo": {
        "040904B0": {
            "CompanyName": "Kafka Explorer contributors",
            "FileDescription": "Kafka Explorer 安装程序",
            "LegalCopyright": "Copyright (C) 2026 Kafka Explorer contributors",
            "ProductName": "Kafka Explorer",
            "FileVersion": VERSION,
            "ProductVersion": VERSION,
            "OriginalFilename": "KafkaExplorer_Setup.exe",
            "InternalName": "KafkaExplorer_Setup",
        }
    },
    "VarFileInfo": {"Translation": {"LangID": "0409", "CharsetID": "04B0"}},
    "IconPath": "build/windows/kafka_icon.ico",
    "ManifestPath": "build/app.manifest",
}

with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"setup versioninfo -> {OUT} ({VERSION})")
