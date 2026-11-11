// Curated Chinese labels/descriptions for common topic configs. Kafka's own
// documentation is English-only; unknown keys fall back to the raw name +
// broker doc string. Keys follow the official topic config names.
export interface ConfigMeta {
  zh: string;
  desc: string;
  doc?: string; // Chinese translation of the official Kafka doc
}

export const TOPIC_CONFIG_DOCS: Record<string, ConfigMeta> = {
  "cleanup.policy": { zh: "清理策略", desc: "日志段过期时的处理方式：delete 按保留期删除，compact 按键压缩保留最新" },
  "retention.ms": { zh: "保留时间（毫秒）", desc: "消息保留的最长时间，超出的日志段可被删除；-1 表示不限时" },
  "retention.bytes": { zh: "保留字节数", desc: "分区可保留的最大字节数，超过后删除最旧日志段；-1 表示不限" },
  "local.retention.ms": { zh: "本地保留时间（毫秒）", desc: "本地日志段保留时间，可小于 retention.ms 以便将旧段卸载到远程存储" },
  "local.retention.bytes": { zh: "本地保留字节数", desc: "本地日志段保留字节数上限" },
  "max.message.bytes": { zh: "单条消息最大字节", desc: "单条消息（含批头）允许写入的最大字节数" },
  "min.insync.replicas": { zh: "最小同步副本数", desc: "acks=all 时至少需要确认的同步副本数量，低于该值写入报错" },
  "segment.bytes": { zh: "日志段大小", desc: "单个日志段文件的大小上限，滚动生成新段" },
  "segment.ms": { zh: "日志段滚动时间（毫秒）", desc: "日志段的最长存活时间，到期滚动新段" },
  "delete.retention.ms": { zh: "墓碑保留时间（毫秒）", desc: "压缩主题中删除标记（墓碑）的保留时长" },
  "min.cleanable.dirty.ratio": { zh: "最小可清理脏比率", desc: "压缩主题触发日志压缩所需的脏数据比率" },
  "compression.type": { zh: "压缩类型", desc: "落盘消息的压缩算法：producer 继承生产者设置，或指定 gzip/snappy/lz4/zstd/none" },
  "compression.gzip.level": { zh: "GZIP 压缩级别", desc: "gzip 压缩级别 1-9，仅 cleanup/压缩或 broker 端压缩生效时使用；越高越慢但越小" },
  "compression.lz4.level": { zh: "LZ4 压缩级别", desc: "lz4 压缩级别 1-9（9 为 LZ4_HC），越高越慢但压缩率更好" },
  "compression.zstd.level": { zh: "ZSTD 压缩级别", desc: "zstd 压缩级别 1-20，越高越慢但压缩率更好" },
  "file.delete.delay.ms": { zh: "文件删除延迟（毫秒）", desc: "日志段被标记删除后，实际删除文件前的等待时间" },
  "segment.jitter.ms": { zh: "滚动抖动（毫秒）", desc: "日志段按时间滚动时叠加的随机抖动，避免大量段同时滚动" },
  "message.timestamp.type": { zh: "时间戳类型", desc: "消息使用的时间戳来源：CreateTime 生产者指定，LogAppendTime 追加时生成" },
  "message.timestamp.after.max.ms": { zh: "时间戳滞后上限（毫秒）", desc: "消息时间戳早于 broker 当前时间超过该值时按策略处理（丢弃或降级）" },
  "message.timestamp.before.max.ms": { zh: "时间戳超前容忍（毫秒）", desc: "消息时间戳晚于 broker 当前时间超过该值时按策略处理（丢弃或降级）" },
  "message.timestamp.difference.max.ms": { zh: "时间戳最大偏差（毫秒）", desc: "消息时间戳与 broker 当前时间允许的最大偏差，超出的按类型处理" },
  "flush.messages": { zh: "强制刷盘消息数", desc: "积累多少条消息后强制 fsync；一般不建议设置（依赖副本更安全）" },
  "flush.ms": { zh: "强制刷盘间隔（毫秒）", desc: "每隔多久强制 fsync 一次" },
  "follower.replication.throttled.replicas": { zh: "副本同步限流-跟随者副本列表", desc: "限流生效的 follower 副本清单，用于副本迁移限速" },
  "leader.replication.throttled.replicas": { zh: "副本同步限流-领导者副本列表", desc: "限流生效的 leader 副本清单" },
  "segment.index.bytes": { zh: "索引文件大小", desc: "偏移量索引文件的大小上限" },
  "unclean.leader.election.enable": { zh: "允许非同步Leader选举", desc: "ISR 全部失效时是否允许非同步副本成为 Leader（可能丢数据）" },
  "max.compaction.lag.ms": { zh: "最大压缩延迟（毫秒）", desc: "消息在日志中保持未压缩的最长时间" },
  "min.compaction.lag.ms": { zh: "最小压缩延迟（毫秒）", desc: "压缩主题中，消息加入脏区之前必须保留的最短时间（与 max.compaction.lag.ms 相对，避免窗口内消息被过早压缩）" },
  "preallocate": { zh: "预分配文件", desc: "创建新日志段时是否预分配整个文件空间" },
  "remote.log.copy.disable": { zh: "禁用远程日志复制", desc: "开启后本主题的新日志段不再复制到远程存储（分层存储），仅写本地" },
  "remote.log.delete.on.disable": { zh: "关闭分层存储时删除远程日志", desc: "关闭 remote.storage.enable 时，是否同步删除已复制到远程存储的日志段" },
  "remote.storage.enable": { zh: "启用远程存储（分层存储）", desc: "开启后旧日志段可卸载到远程对象存储，本地仅保留热数据（保留窗口见 local.retention.*）" },
  "message.format.version": { zh: "消息格式版本", desc: "落盘使用的消息格式版本（旧版本兼容用）" },
  "message.downconversion.enable": { zh: "启用降档转换", desc: "消费请求格式较低时是否自动转换消息格式（消耗 CPU）" },
  "index.interval.bytes": { zh: "索引间隔字节数", desc: "偏移索引中相邻两条索引项之间的字节数" },
};

export function configMeta(name: string): ConfigMeta | undefined {
  return TOPIC_CONFIG_DOCS[name];
}

// Enum-style configs and their known choices — the config table renders
// these as a dropdown instead of a free-text box.
export const CONFIG_OPTIONS: Record<string, string[]> = {
  "cleanup.policy": ["delete", "compact", "delete,compact"],
  "compression.type": ["uncompressed", "producer", "gzip", "snappy", "lz4", "zstd"],
  "message.timestamp.type": ["CreateTime", "LogAppendTime"],
};

// Boolean configs — the config table renders these as a switch.
export const BOOLEAN_CONFIGS = new Set([
  "preallocate",
  "remote.storage.enable",
  "remote.log.copy.disable",
  "remote.log.delete.on.disable",
  "message.downconversion.enable",
  "unclean.leader.election.enable",
]);

// Chinese translations of the official Kafka topic docs, keyed by config
// name — shown as the "官方文档" layer in the edit dialog.
export const TOPIC_DOC: Record<string, string> = {
  "cleanup.policy": "日志段过期时的处理方式。delete：按保留时间/大小删除旧日志段；compact：按消息键只保留每个键的最新值（适合有状态存储、变更日志主题）。两者可组合为 \"delete,compact\"。",
  "retention.ms": "分区数据的保留时长（毫秒），超过后删除旧日志段。默认 7 天；-1 表示不限时（此时只能靠 retention.bytes 或 compact 控制大小）。",
  "retention.bytes": "分区允许保留的最大字节数，超过后从最旧的日志段开始删除。默认 -1 表示不限。",
  "local.retention.ms": "分层存储启用时，日志段在本地磁盘的最短保留时长。可以小于 retention.ms，使旧数据只保留在远程存储；-2 表示跟随 retention.ms。",
  "local.retention.bytes": "分层存储启用时，本地磁盘保留的最大字节数；-2 表示跟随 retention.bytes。",
  "max.message.bytes": "单条消息批次允许的最大字节数。消费者与副本拉取配置必须足够大，否则无法读取。",
  "min.insync.replicas": "配合生产者 acks=all 使用：同步副本数（ISR）低于此值时写入返回 NotEnoughReplicas，防止写入只落在单副本上。",
  "segment.bytes": "单个日志段文件的滚动大小上限。段是保留、压缩、索引的最小操作单元。",
  "segment.ms": "日志段的最长存活时间，到期后强制滚动新段（即使未写满 segment.bytes）。",
  "delete.retention.ms": "压缩主题中删除标记（墓碑）的保留时长，超过后墓碑被彻底清除，新加入的消费者将看不到删除。",
  "min.cleanable.dirty.ratio": "压缩触发条件之一：日志脏区占比超过该值时才执行压缩。越小压缩越频繁。",
  "compression.type": "broker 端落盘压缩算法。producer 表示保留生产者的压缩格式；指定具体算法则由 broker 重新压缩。",
  "compression.gzip.level": "gzip 压缩级别 1-9。仅当消息被重新压缩（如 broker 端压缩或压缩主题）时生效。",
  "compression.lz4.level": "lz4 压缩级别 1-9（9 为 LZ4_HC），越高压缩率越好但 CPU 消耗更大。",
  "compression.zstd.level": "zstd 压缩级别 1-20，越高压缩率越好但 CPU 消耗更大。",
  "file.delete.delay.ms": "日志段被标记删除后，实际删除文件前再等待的时长。",
  "segment.jitter.ms": "按时间滚动日志段时叠加的最大随机抖动，避免大量主题同时滚动造成 IO 峰值。",
  "message.timestamp.type": "消息时间戳来源：CreateTime 由生产者指定；LogAppendTime 由 broker 在追加时写入。",
  "message.timestamp.after.max.ms": "允许消息时间戳落后 broker 当前时间的最大毫秒数，超出后按 timestamp.type 配置处理（拒绝或降级）。",
  "message.timestamp.before.max.ms": "允许消息时间戳超前 broker 当前时间的最大毫秒数，防止未来时间戳污染延迟计算。",
  "message.timestamp.difference.max.ms": "旧版统一的时间戳偏差检查参数（已由 before/after 两个参数取代）。",
  "flush.messages": "每积累多少条消息强制 fsync 一次。强制刷盘会降低吞吐，一般依赖副本机制保证可靠性。",
  "flush.ms": "每隔多少毫秒强制 fsync 一次。",
  "follower.replication.throttled.replicas": "跟随者副本复制的限流清单，格式如 0:1,1:2（分区:副本）。用于分区迁移时限速。",
  "leader.replication.throttled.replicas": "Leader 副本复制的限流清单，格式同上。与 follower 限流配合使用。",
  "segment.index.bytes": "偏移索引文件的大小上限，达到后强制滚动日志段。",
  "unclean.leader.election.enable": "ISR 中没有存活副本时，是否允许非同步副本成为 Leader。开启可提高可用性但可能丢数据。",
  "max.compaction.lag.ms": "消息保持未压缩的最长时间，超过后即使脏比率不足也强制压缩。保证压缩主题的读放大有上限。",
  "min.compaction.lag.ms": "消息进入脏区后的最短保留时间，期间不会被压缩。给慢消费者留出读取窗口。",
  "preallocate": "创建新日志段时是否一次性预分配整个文件空间，减少写入时的文件增长碎片。",
  "remote.log.copy.disable": "开启后本主题的新日志段不再复制到远程存储（即使集群启用分层存储）。",
  "remote.log.delete.on.disable": "关闭 remote.storage.enable 时，是否同时删除已上传到远程存储的日志段。",
  "remote.storage.enable": "启用分层存储：超过 local.retention.* 的旧日志段卸载到远程对象存储，本地只保留热数据。开启后不可完全关闭（只能禁复制）。",
  "message.format.version": "落盘使用的消息格式版本。仅用于兼容旧消费者，Kafka 3.0 之后只有 3.0+ 一种格式。",
  "message.downconversion.enable": "消费者请求的消息格式版本较低时，broker 是否把消息降档转换（消耗 CPU 与带宽）。",
  "index.interval.bytes": "每写入多少字节添加一条偏移索引项。值越小查找越快但索引越大。",
};
// Merge translated official docs into the lookup so configMeta consumers
// (configDescParts) can pick them up.
for (const [k, doc] of Object.entries(TOPIC_DOC)) {
  const meta = TOPIC_CONFIG_DOCS[k];
  if (meta) meta.doc = doc;
}
