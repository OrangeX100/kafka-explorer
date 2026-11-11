// Decoders for Kafka internal topics' binary record formats. Offsets keys
// are versioned structs (int16 version + group/topic/partition), values are
// (version + offset + metadata + timestamp). Share-group state uses a
// different opaque format and stays hex — only the offsets topic is decoded.
// Everything here is pure: base64 in, display strings out.

type OffsetsKey = { group: string; topic: string; partition: number };

function be16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function be32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}


function base64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// printable: names in these structs are human-chosen strings (group, topic).
// A byte run full of control characters means we are NOT looking at a name.
function printable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09) return false;
  }
  return s.length > 0;
}

// decodeOffsetsKey parses the __consumer_offsets key struct. Per Kafka's
// OffsetCommitKey source, the VERSION selects the record type — not a
// shape heuristic: v0/v1 are offset commits
// ([version][group][topic][partition], fully consumed), while v2+ are group
// metadata ([version][group] + opaque protocol/members body). Share groups
// (KIP-932) write group-metadata keys with versions beyond the classic set;
// the old version whitelist rejected those and the table showed raw
// replacement glyphs instead of the decoded group name.
export function decodeOffsetsKey(b64: string): OffsetsKey | { groupOnly: string } | null {
  const b = base64Bytes(b64);
  if (!b || b.length < 4) return null;
  const version = be16(b, 0);
  let at = 2;
  const readStr = (): string | null => {
    if (at + 2 > b.length) return null;
    const len = be16(b, at);
    at += 2;
    if (at + len > b.length) return null;
    const s = new TextDecoder().decode(b.subarray(at, at + len));
    at += len;
    return s;
  };
  const group = readStr();
  if (group === null || !printable(group)) return null;
  if (version >= 2) return { groupOnly: group }; // group metadata body is opaque
  // v0/v1 offset commit: [topic][partition] and nothing else. Names must be
  // printable and the buffer must be fully consumed, otherwise the bytes
  // were not a commit key after all.
  const topic = readStr();
  if (topic === null || !printable(topic) || at + 4 !== b.length) return null;
  const partition = be32(b, at) | 0; // signed int32
  if (partition < 0) return null;
  return { group, topic, partition };
}

// decodeOffsetsValue parses the offset-commit value struct: v0/v1 use fixed
// int16 lengths; v2/v3/v4 are flexible versions (leaderEpoch before a
// varint-length metadata, plus a tagged-field tail). Only the committed
// offset matters in the table.
export function decodeOffsetsValue(b64: string): string | null {
  const b = base64Bytes(b64);
  if (!b || b.length < 6) return null;
  const version = be16(b, 0);
  if (version === 0 || version === 1) {
    if (2 + 4 + 2 > b.length) return null;
    return `offset=${be32(b, 2) | 0}`;
  }
  if (version >= 2 && version <= 4) {
    // version(2) + offset(4) + leaderEpoch(4) + metadata(uvarint-len string)
    if (2 + 4 + 4 + 1 > b.length) return null;
    return `offset=${be32(b, 2) | 0}`;
  }
  return null;
}


// isInternalTopic: Kafka-reserved topics carry cluster state and get both a
// visual badge and blocked mutations. __-prefixed topics drive RECORD
// DECODING too — that must stay __-only: _schemas records are plain JSON
// and would be mangled by the offsets decoder below. For MUTATION
// protection (the wider set) use isProtectedTopic instead.
export function isInternalTopic(name: string): boolean {
  return name.startsWith("__");
}

// Ecosystem topics: created by Kafka-ecosystem services as NORMAL topics —
// the broker reports IsInternal=false for them (single underscore is not
// the Kafka-internal convention), yet deleting one wipes the owning
// service's data (deleting _schemas destroys every registered schema).
// Exact names on purpose: each service's storage topic is configurable, so
// any prefix guess (_, connect-, …) would false-positive on user topics.
const ECOSYSTEM_TOPICS: ReadonlySet<string> = new Set([
  "_schemas", // Confluent Schema Registry storage
  "connect-configs", // Kafka Connect (default names)
  "connect-offsets",
  "connect-status",
  "_confluent-command", // Confluent platform support topics
  "_confluent-metrics",
  "_confluent-telemetry-metrics",
]);

export function isEcosystemTopic(name: string): boolean {
  // _confluent-ksql- is the one prefix: ksqlDB internal topics are
  // _confluent-ksql-<service-id>... with a user-chosen service id.
  return name.startsWith("_confluent-ksql-") || ECOSYSTEM_TOPICS.has(name);
}

// isProtectedTopic: mutation (delete topic / send / import / delete
// records / config edit) is refused for both tiers. Mirrors
// domain.ProtectedTopicTierOf on the Go side.
export function isProtectedTopic(name: string): boolean {
  return name.startsWith("__") || isEcosystemTopic(name);
}

// decodeInternalRecordText builds a human-readable multi-line description of
// an internal-topic record (offset commit or group metadata), combining the
// decoded key and value. Returns null for non-internal topics or records the
// decoders cannot parse (unknown versions — the Hex tab still shows bytes).
export function decodeInternalRecordText(
  topic: string,
  keyB64: string,
  valueB64: string,
  labels: InternalRecordLabels,
): string | null {
  if (!isInternalTopic(topic)) return null;
  const key = decodeOffsetsKey(keyB64 ?? "");
  if (!key) {
    if (topic === "__share_group_state") {
      const sg = decodeShareGroupStateKey(keyB64 ?? "");
      if (sg) {
        const n = (base64Bytes(valueB64 ?? "") ?? []).length;
        return [`${labels.shareKey}: ${sg.group}`, n === 0 ? labels.tombstone : labels.shareValue(n)].join(NEWLINE);
      }
    }
    const n = (base64Bytes(valueB64 ?? "") ?? []).length;
    return labels.genericKey(topic, n);
  }
  const lines: string[] = [];
  if ("topic" in key) {
    lines.push(labels.commit);
    lines.push(`${labels.group}: ${key.group}`);
    lines.push(`${labels.topicPart}: ${key.topic}#${key.partition}`);
    const value = decodeOffsetsValue(valueB64 ?? "");
    if (value) lines.push(`${labels.offset}: ${value.replace("offset=", "")}`);
  } else {
    lines.push(labels.metadata);
    lines.push(`${labels.group}: ${key.groupOnly}`);
    const n = (base64Bytes(valueB64 ?? "") ?? []).length;
    if (n > 0) lines.push(labels.metadataBytes(n));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export interface InternalRecordLabels {
  commit: string;
  metadata: string;
  group: string;
  topicPart: string;
  offset: string;
  metadataBytes: (n: number) => string;
  shareKey: string;
  tombstone: string;
  shareValue: (n: number) => string;
  genericKey: (topic: string, size: number) => string;
  genericValue: (size: number) => string;
}

// decodeShareGroupStateKey parses KIP-932 share-group state keys
// (__share_group_state): [version:2][groupId:string][...opaque body —
// UUID + partition id in v0]. Verified against live bytes:
// 0000 0008 "sg-probe" <16-byte UUID> 00000000.
// Returns null when the buffer is malformed or the group is not printable.
const NEWLINE = String.fromCharCode(10);

export function decodeShareGroupStateKey(keyB64: string): { group: string } | null {
  const b = base64Bytes(keyB64);
  if (!b || b.length < 4) return null;
  const gl = be16(b, 2);
  if (4 + gl > b.length) return null;
  const group = new TextDecoder().decode(b.subarray(4, 4 + gl));
  if (!printable(group)) return null;
  return { group };
}

// Generic fallback for internal-topic records nothing decodes
// (transaction state, cluster metadata, ...) — a labeled note instead of
// replacement glyphs. topic includes the __ prefix.
export function internalGenericLabel(topic: string, size: number, t: T): { key: string; value: string } {
  return {
    key: t("internal.genericKey", topic, size),
    value: t("internal.genericValue", size),
  };
}

// Display helpers used by the messages view. They take t so the util stays
// React-free while the labels stay localized.
type T = (key: string, ...args: (string | number)[]) => string;

// internalRowDisplay renders the Key/Value cells of an internal-topic row:
// decoded group/topic/partition + committed offset, or a metadata label.
export function internalRowDisplay(
  topic: string,
  keyB64: string,
  valueB64: string,
  t: T,
): { key: string | null; value?: string } {
  // Non-internal topics: no opinion here — the caller's binary sniffer
  // (shared/binary.ts) provides encoding fallbacks and format labels.
  if (!isInternalTopic(topic)) return { key: null };
  const key = decodeOffsetsKey(keyB64 ?? "");
  if (!key) {
    // __share_group_state: KIP-932 share-group state records (key carries
    // version + group; empty value = tombstone after a cleanup run — the
    // user-visible case on partition 23).
    if (topic === "__share_group_state") {
      const sg = decodeShareGroupStateKey(keyB64 ?? "");
      if (sg) {
        const n = (base64Bytes(valueB64 ?? "") ?? []).length;
        return {
          key: `${sg.group} · ${t("internal.shareKey")}`,
          value: n === 0 ? t("internal.tombstone") : t("internal.shareValue", n),
        };
      }
    }
    // Every other internal topic (or an unrecognized shape of a known one):
    // labeled note — internal topics NEVER fall through to glyph soup.
    return internalGenericLabel(topic, (base64Bytes(valueB64 ?? "") ?? []).length, t);
  }
  if ("topic" in key) {
    return {
      key: `${key.group} / ${key.topic}#${key.partition}`,
      value: decodeOffsetsValue(valueB64 ?? "") ?? undefined,
    };
  }
  return {
    key: `${key.groupOnly} · ${t("msg.groupMetadata")}`,
    // The metadata body is opaque member/assignment bytes — show its size
    // instead of dumping replacement glyphs into the Value cell.
    value: t("internal.metadataBytes", (base64Bytes(valueB64 ?? "") ?? []).length),
  };
}

// internalRecordOverride builds the decoded-tab content for the selected
// internal-topic message (same mechanics as a registry-backed Avro decode).
export function internalRecordOverride(
  topic: string,
  keyB64: string,
  valueB64: string,
  t: T,
  metadataBytesLabel?: (n: number) => string,
): { format: string; text: string } | undefined {
  const text = decodeInternalRecordText(topic, keyB64 ?? "", valueB64 ?? "", {
    commit: t("internal.commit"),
    metadata: t("internal.metadata"),
    group: t("internal.group"),
    topicPart: t("internal.topicPart"),
    offset: t("internal.offset"),
    // pass the formatter: pre-rendering via t() would consume the {0}
    // placeholder before the byte count is known
    metadataBytes: (n: number) =>
      metadataBytesLabel ? metadataBytesLabel(n) : t("internal.metadataBytes", n),
    shareKey: t("internal.shareKey"),
    tombstone: t("internal.tombstone"),
    shareValue: (n: number) => t("internal.shareValue", n),
    genericKey: (tp: string, size: number) => t("internal.genericKey", tp, size),
    genericValue: (size: number) => t("internal.genericValue", size),
  });
  return text ? { format: t("msg.decodedOffsets"), text } : undefined;
}

