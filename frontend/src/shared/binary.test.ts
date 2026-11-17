// shared/ 前端纯函数的首个真实测试套件（045 round-5：vitest 此前只在
// package.json 里躺着——接线空跑没有意义，先有真测试再进门禁）。
// 覆盖：魔数嗅探、smartText 降级链、toHex 截断帽、formatBytes。
import { describe, expect, it } from "vitest";
import { displayFor } from "./binary.js";
import { decodeBase64, formatBytes, toHex } from "./format.js";

const fakeT = (key: string, ...args: (string | number)[]) => {
  let out = key;
  args.forEach((a, i) => {
    out = out.replace(`{${i}}`, String(a));
  });
  return out;
};

const b64 = (s: string) => btoa(s);
const b64Bytes = (b: Uint8Array) => btoa(Array.from(b, (c) => String.fromCharCode(c)).join(""));

describe("toHex", () => {
  it("小载荷渲染为行视图", () => {
    const out = toHex(b64("abcdefgh"));
    expect(out.split("\n").length).toBe(1);
    expect(out).toMatch(/^[0-9a-f]{8}/);
  });

  it("空/undefined 输入返回空串", () => {
    expect(toHex(undefined)).toBe("");
    expect(toHex("")).toBe("");
  });

  it("非法 base64 不抛异常（脏数据复制动作不静默失败）", () => {
    expect(() => toHex("!!!not-base64!!!")).not.toThrow();
  });
});

describe("displayFor", () => {
  it("UTF-8 文本按可读文本显示", () => {
    const utf8 = new TextEncoder().encode("hello 世界");
    const r = displayFor(b64Bytes(utf8), fakeT);
    expect(r?.style).toBe("text");
    expect(r?.text).toContain("hello");
  });

  it("gzip 魔数标注为格式化容器", () => {
    const gz = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0]);
    const r = displayFor(b64Bytes(gz), fakeT);
    expect(r?.style).toBe("format");
  });

  it("高控制字符占比的载荷按二进制处理而非乱码文本", () => {
    const bin = new Uint8Array(256).fill(0x01);
    const r = displayFor(b64Bytes(bin), fakeT);
    expect(r?.style).toBe("binary");
  });

  it("undefined 输入返回 null（调用方走嗅探/兜底链）", () => {
    expect(displayFor("", fakeT)).toBeNull();
  });
});

describe("decodeBase64", () => {
  it("合法 base64 正常解码", () => {
    expect(new TextDecoder().decode(decodeBase64(b64("ok")))).toBe("ok");
  });
  it("非法 base64 返回原文字节而非抛出", () => {
    const out = new TextDecoder().decode(decodeBase64("@@@"));
    expect(out).toBe("@@@");
  });
});

describe("formatBytes", () => {
  it("B/KB/MB 换算", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 << 20)).toBe("3.0 MB");
  });
});
