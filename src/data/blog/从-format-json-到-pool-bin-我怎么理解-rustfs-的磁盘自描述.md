---
title: "图解 RustFS 磁盘自描述：从 format.json 到 pool.bin（2026）"
author: F3D
pubDatetime: 2026-06-29T15:23:56+08:00
description: "沿一次 4 节点 8 磁盘实验，追踪 RustFS 如何用 RUSTFS_VOLUMES、format.json、set、xl.meta 和 pool.bin 重建存储视图。"
tags:
  - release
  - rustfs
  - storage
  - rust
draft: false
---

RustFS 的 `.rustfs.sys/` 目录里，有两个很容易误判的对象：每盘一份的 `format.json`，以及看起来像系统元数据的 `pool.bin/xl.meta`。

如果只看目录结构，很容易把它们理解成某种中心元数据。但从启动拓扑、磁盘身份、对象 hash 和 `xl.meta/part.N` 的关系看，RustFS 的恢复模型更像一组分层规则。

本文按运行顺序展开：先看一个分布式 RustFS 怎么启动，为什么任意节点都能恢复同一张 pool/set/disk 拓扑；再沿一次 2 MiB PUT 看对象怎么进入 set，并落成 `xl.meta` 和 `part.1`；最后把容易误判的 `pool.bin` 放回系统元数据位置。

实验拓扑：RustFS 源码 `main@acdf43937162b247619c6a32a5fe079146ca794d`，4 个节点，每个节点 2 块盘，一共 8 个 disk endpoint。实验形成 1 个 pool、1 个 set，上传一个 2 MiB 对象后观察磁盘文件和源码路径。

![RustFS PUT 请求从 S3 客户端进入任意节点，再根据 RUSTFS_VOLUMES、format.json 和对象名哈希写入 pool 0 set 0 的 8 个磁盘分片](https://img.f3dlife.com/blog/2026/06/29/rustfs-put-topology-437921a8-83f3-4cf9-a355-854be73fec60.svg)
Fig. RustFS 4 节点 8 磁盘实验拓扑：`RUSTFS_VOLUMES` 给出 endpoint 列表，`format.json` 给出磁盘身份和 set 布局，对象名哈希选择 set，`xl.meta/part.1` 保存对象元数据和分片。

## 目录

- [1 问题与环境](#1-问题与环境)
- [2 启动入口：RUSTFS_VOLUMES 定义同一张拓扑图](#2-启动入口rustfs_volumes-定义同一张拓扑图)
- [3 format.json：为什么节点能恢复 pool/set/disk 视图](#3-formatjson为什么节点能恢复-poolsetdisk-视图)
- [4 PUT 2 MiB：对象如何进入 set 并落盘](#4-put-2-mib对象如何进入-set-并落盘)
- [5 pool.bin：pool 生命周期账本，不是对象索引](#5-poolbinpool-生命周期账本不是对象索引)
- [6 纠删码边界：4+4、6+2、8+4 到底差在哪](#6-纠删码边界4484-到底差在哪)
- [7 pool、set 与扩容/坏槽位](#7-poolset-与扩容坏槽位)
- [8 小结](#8-小结)
- [参考资料](#参考资料)

## 1 问题与环境

本文只验证四类证据：启动日志与 `RUSTFS_VOLUMES`、`format.json` 内容、一次 2 MiB PUT 后的 `xl.meta`/`part.1` 写入结果、RustFS 源码里的启动/set 选择/pool metadata 入口。不覆盖 rebalance/decommission 的完整状态机。

要回答的问题是：

1. 节点从哪里知道集群有哪些磁盘？
2. 每块盘怎么证明“我属于这个部署、我是 set 里的第几块盘”？
3. 一个对象怎么从名字映射到某个 set？
4. `pool.bin` 存了什么，它在架构里处在哪一层？
5. 纠删码里的 `6+2`、`4+4`、`8+4` 容忍的是盘、机器，还是别的边界？

实验环境如下：

| 项目 | 值 |
| --- | --- |
| RustFS 源码 | `main@acdf43937162b247619c6a32a5fe079146ca794d` |
| 节点数 | 4 |
| 每节点磁盘数 | 2 |
| disk endpoint 总数 | 8 |
| pool / set | 1 pool / 1 set |
| 上传对象 | `dist-bucket/dist-large-2m.bin` |
| 对象逻辑大小 | 2097152 B，也就是 2 MiB |

下面所有输出都来自这个实验环境。为避免发布本机挂载路径，命令输出里的 `/data/rustfs-dist/` 前缀会显式省略成 `nodeN/diskN/` 这种实验拓扑路径；对象 data dir UUID 在路径里用 `<data-dir>` 标记。

## 2 启动入口：RUSTFS_VOLUMES 定义同一张拓扑图

先看实验是怎么起的。

这篇里的“4 节点 8 磁盘”不是 4 台真实服务器，而是在一台机器上用 4 个 RustFS 进程模拟 4 个节点。每个节点挂两块目录盘：

```text
解释模型，不是原始输出:
node1: /data1, /data2  -> <mount>/rustfs-dist/node1/disk1, disk2
node2: /data1, /data2  -> <mount>/rustfs-dist/node2/disk1, disk2
node3: /data1, /data2  -> <mount>/rustfs-dist/node3/disk1, disk2
node4: /data1, /data2  -> <mount>/rustfs-dist/node4/disk1, disk2
```

关键配置是一模一样的 `RUSTFS_VOLUMES`。在这个实验里，它的值是 8 个 endpoint：

```bash
export RUSTFS_VOLUMES="http://node1:9000/data1 http://node1:9000/data2 http://node2:9000/data1 http://node2:9000/data2 http://node3:9000/data1 http://node3:9000/data2 http://node4:9000/data1 http://node4:9000/data2"
```

这行的含义很直接：

```text
解释模型，不是原始输出:
http://node1:9000/data1  node1 的第 1 块盘
http://node1:9000/data2  node1 的第 2 块盘
...
http://node4:9000/data2  node4 的第 2 块盘
```

如果用容器在单机上复现实验，启动形态可以写成下面这样。这里的 `<image>` 是本地构建或拉取的 RustFS 镜像；`<mount>` 是发布文章时脱敏后的宿主机挂载点。

```bash
mkdir -p <mount>/rustfs-dist/node{1,2,3,4}/{disk1,disk2,logs}

docker network create rustfs-dist

for n in 1 2 3 4; do
  docker run -d --name "node${n}" --hostname "node${n}" \
    --network rustfs-dist \
    -p "$((8999 + n)):9000" \
    -e RUSTFS_ADDRESS=":9000" \
    -e RUSTFS_CONSOLE_ENABLE="false" \
    -e RUSTFS_VOLUMES="$RUSTFS_VOLUMES" \
    -v "<mount>/rustfs-dist/node${n}/disk1:/data1" \
    -v "<mount>/rustfs-dist/node${n}/disk2:/data2" \
    -v "<mount>/rustfs-dist/node${n}/logs:/logs" \
    <image>
done
```

这不是唯一部署方式。真实多机时，`node1` 到 `node4` 会换成机器 DNS/IP，本地挂载路径会换成各机器自己的磁盘路径；关键不变：**所有节点拿到同一份 `RUSTFS_VOLUMES` endpoint 列表。**

实际日志能看到这个拓扑被识别出来。下面是 node1 日志中的几行；`/data1`、`/data2` 是 node1 本地盘，`http://node2:9000/data1` 这类是远端盘：

```text
{"timestamp":"2026-06-29T01:38:39.237414309Z","level":"INFO","fields":{"message":"Disk \"/data1\" is online"},"target":"rustfs_ecstore::set_disk::lock","filename":"crates/ecstore/src/set_disk/lock.rs","line_number":262,"threadName":"rustfs-worker","threadId":"ThreadId(29)"}
{"timestamp":"2026-06-29T01:38:39.237443614Z","level":"INFO","fields":{"message":"Disk \"/data2\" is online"},"target":"rustfs_ecstore::set_disk::lock","filename":"crates/ecstore/src/set_disk/lock.rs","line_number":262,"threadName":"rustfs-worker","threadId":"ThreadId(29)"}
{"timestamp":"2026-06-29T01:38:39.237477888Z","level":"INFO","fields":{"message":"Disk \"http://node2:9000/data1\" is online"},"target":"rustfs_ecstore::set_disk::lock","filename":"crates/ecstore/src/set_disk/lock.rs","line_number":262,"threadName":"rustfs-worker","threadId":"ThreadId(29)"}
{"timestamp":"2026-06-29T01:38:39.237496253Z","level":"INFO","fields":{"message":"Disk \"http://node2:9000/data2\" is online"},"target":"rustfs_ecstore::set_disk::lock","filename":"crates/ecstore/src/set_disk/lock.rs","line_number":262,"threadName":"rustfs-worker","threadId":"ThreadId(29)"}
```

这个日志证明了一件事：从 node1 的视角，它既能看到本地磁盘，也能通过 endpoint 看到其他节点的磁盘。

再回到源码入口。RustFS server 的 volumes 参数来自命令行或环境变量 `RUSTFS_VOLUMES`。源码里 `ServerOpts.volumes` 标了 `env = "RUSTFS_VOLUMES"`，并用空格拆分 endpoint 列表：

```rust
#[arg(
    required = true,
    env = "RUSTFS_VOLUMES",
    value_delimiter = ' ',
    value_parser = NonEmptyStringValueParser::new()
)]
pub volumes: Vec<String>,
```

源码锚点：
[`rustfs/src/config/cli.rs#L172-L182`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/rustfs/src/config/cli.rs#L172-L182)
说明 `ServerOpts.volumes` 可以从 `RUSTFS_VOLUMES` 读取，并按空格切分成 endpoint 列表。

也就是说，多机部署不是靠节点随便广播“我要加入哪个集群”。更准确的模型是：

```text
解释模型，不是原始输出:
all nodes receive the same RUSTFS_VOLUMES
  -> parse endpoint list
  -> decide local endpoints vs remote endpoints
  -> read or create per-disk format.json
  -> build pool / set / disk mapping
```

`RUSTFS_VOLUMES` 给出预期拓扑，但它本身还不足以说明“这块盘是谁”。磁盘身份落在 `.rustfs.sys/format.json`。

这个顺序很重要：节点不是先扫描目录再猜集群有哪些盘，而是先拿到同一份 endpoint 拓扑，再用本地/远端磁盘上的 `format.json` 校验这张拓扑。

## 3 format.json：为什么节点能恢复 pool/set/disk 视图

这里要验证的是：`format.json` 是每块盘的身份文件。真实 JSON 里 `id` 在同一部署内相同，`xl.sets` 记录 set 矩阵，而每块盘的 `xl.this` 不同。

```bash
# cwd: <mount>/rustfs-dist
jq . node1/disk1/.rustfs.sys/format.json
for f in node*/disk*/.rustfs.sys/format.json; do
  jq -r .xl.this "$f"
done | sort
```

![RustFS format.json 真实 JSON 结构显示顶层 id、xl.this、xl.sets 和 distributionAlgo，并列出 8 个磁盘的 this UUID](https://img.f3dlife.com/blog/2026/06/29/rustfs-format-json-54324099-3fa2-495c-b501-83ad78519651.png)
Fig. `format.json` 的真实结构：顶层 `id` 标识部署，`xl.sets[0]` 是包含 8 个磁盘 UUID 的 set，`xl.this` 标识当前磁盘。

抽取其中一块盘的 `format.json`，真实形状是：

```json
{
  "version": "1",
  "format": "xl",
  "id": "13c779ee-1cf5-4b6d-bbfd-8c5298e04e2e",
  "xl": {
    "version": "3",
    "this": "63124b32-a325-4072-9b45-e56a8eb6ae75",
    "sets": [
      [
        "63124b32-a325-4072-9b45-e56a8eb6ae75",
        "7cee30d3-b5bb-4591-8931-f5998f8eb455",
        "... 6 more disk UUIDs omitted ..."
      ]
    ],
    "distributionAlgo": "SIPMOD+PARITY"
  }
}
```

上面的 `"... 6 more disk UUIDs omitted ..."` 是明确省略，真实文件里这里还有 6 个 disk UUID。这里直接读真实字段：`id` 是部署 ID，`xl.this` 是当前磁盘 UUID，`xl.sets` 是 set 矩阵，`xl.distributionAlgo` 是分布算法。

8 块盘的 `this` 正好是 8 个不同 UUID：

```text
0c57ef04-0734-4851-b96f-ca32a2194512
1106aec2-0326-4292-a1d2-75869e183d28
54462c11-0012-4430-a764-087666e6c87a
6050e0a2-7639-4e2f-8cf3-802e7062959c
63124b32-a325-4072-9b45-e56a8eb6ae75
7cee30d3-b5bb-4591-8931-f5998f8eb455
d30eade3-aee9-4bea-832e-337e187d6422
f089621e-7aa2-4772-959f-42c2aae42f30
```

源码里的创建逻辑也能对上这个现象：`init_format_erasure` 先创建一个包含 `sets` 的 `FormatV3`，然后按 `(set_idx, disk_idx)` 给每块盘写入不同的 `erasure.this`，最后保存到所有磁盘。

```rust
for i in 0..set_count {
    for j in 0..set_drive_count {
        let idx = i * set_drive_count + j;
        let mut newfm = fm.clone();
        newfm.erasure.this = fm.erasure.sets[i][j];
        fms[idx] = Some(newfm);
    }
}

save_format_file_all(disks, &fms).await?;
```

源码锚点：
[`crates/ecstore/src/store_init.rs#L129-L150`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store_init.rs#L129-L150)
说明初始化时会按 set/disk 下标给每块盘写入不同的 `erasure.this`，然后保存 `format.json`。

所以 RustFS 的“磁盘自描述”不是说每块盘保存了所有动态状态，而是说每块盘保存了足够稳定的身份和布局信息：

```text
解释模型，不是原始输出:
deployment id: 我属于哪个部署
this: 我是哪块盘
sets: 这个 pool 的 set 矩阵长什么样
distributionAlgo: 对象分布算法是什么
```

**启动时，`RUSTFS_VOLUMES` 是拓扑输入，`format.json` 是磁盘身份账本。两者对得上，节点才能恢复出同一套 pool/set/disk 视图。**

## 4 PUT 2 MiB：对象如何进入 set 并落盘

有了 pool/set/disk 视图之后，对象写入还需要解决另一个问题：这个 object key 进入哪个 set？

RustFS 在 `Sets` 里有一个很直接的路径。下面摘出两个相关函数；它们在源码中间隔着 storage info 相关函数，这里只保留 set 选择路径：

```rust
pub fn get_disks_by_key(&self, key: &str) -> Arc<SetDisks> {
    self.get_disks(self.get_hashed_set_index(key))
}

fn get_hashed_set_index(&self, input: &str) -> usize {
    match self.distribution_algo {
        DistributionAlgoVersion::V1 => crc_hash(input, self.disk_set.len()),
        DistributionAlgoVersion::V2 | DistributionAlgoVersion::V3 => {
            sip_hash(input, self.disk_set.len(), self.id.as_bytes())
        }
    }
}
```

源码锚点：
[`crates/ecstore/src/sets.rs#L287-L340`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/sets.rs#L287-L340)
说明对象名会先映射到 set index，再拿到该 set 对应的磁盘集合。

这段代码说明两件事。

第一，set 选择不是扫描目录得出的，而是由 object key 确定性哈希得出的。

第二，实验里的 `distributionAlgo` 是 `SIPMOD+PARITY`，对应 V2/V3 的 sip hash 路径；hash key 用的是 deployment id。

这个实验里只有一个 set，所以所有对象都会落到 set 0。但在多个 set 的 pool 中，路径会变成：

```text
解释模型，不是原始输出:
object name
  -> sip_hash(object_name, set_count, deployment_id)
  -> set index
  -> set disks
  -> xl.meta + part.N shards
```

这也是为什么“只看目录”会误导：目录是写入后的形态，不是对象定位的规则。对象先通过 hash 进入某个 set，再在 set 内按纠删码布局写出 `xl.meta` 和 `part.1`。

沿着 PUT 路径走到落盘阶段，再检查写入结果。这里要验证的是：8 块盘上都有用户对象 `xl.meta`，并且同一个对象在 8 块盘上各有一个 `part.1` 分片；截图里同时出现的 `format.json` 和 `pool.bin/xl.meta` 是系统元数据，后面会单独解释。

```bash
# cwd: <mount>/rustfs-dist
stat -c '%n %s bytes' node*/disk*/.rustfs.sys/format.json \
  node*/disk*/.rustfs.sys/pool.bin/xl.meta \
  node*/disk*/dist-bucket/dist-large-2m.bin/xl.meta
find node*/disk*/dist-bucket/dist-large-2m.bin -name part.1 \
  -exec stat -c '%n %s bytes' {} \;
```

![RustFS 4 节点 8 磁盘实验里，每块盘都有 format.json、pool.bin/xl.meta、对象 xl.meta，且每块盘的 part.1 分片大小都是 524352 字节](https://img.f3dlife.com/blog/2026/06/29/rustfs-layout-stat-2a64aa30-6a35-42f4-bfea-4946d3c95274.png)
Fig. PUT 2 MiB 对象后的磁盘文件证据：系统元数据、对象元数据和 `part.1` 分片都分布在 8 块盘上。

```text
node1/disk1/.rustfs.sys/format.json 498 bytes
node1/disk1/.rustfs.sys/pool.bin/xl.meta 537 bytes
node1/disk1/dist-bucket/dist-large-2m.bin/xl.meta 413 bytes
... 12 metadata lines omitted ...
node4/disk2/.rustfs.sys/format.json 498 bytes
node4/disk2/.rustfs.sys/pool.bin/xl.meta 537 bytes
node4/disk2/dist-bucket/dist-large-2m.bin/xl.meta 413 bytes
```

对象的数据分片完整列表如下：

```text
node1/disk1/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node1/disk2/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node2/disk1/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node2/disk2/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node3/disk1/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node3/disk2/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node4/disk1/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
node4/disk2/dist-bucket/dist-large-2m.bin/<data-dir>/part.1 524352 bytes
```

这组数字给出对象路径的结果：

```text
解释模型，不是原始输出:
2 MiB 逻辑对象
  -> hash 到 pool 0 / set 0
  -> 8 个 part.1
  -> 每个 part.1 524352 B
  -> 合计约 4 MiB
```

这不是 8 份完整复制，而是 4+4 纠删码：4 个 data shard，4 个 parity shard。**对象恢复依赖 set 内的 shard 和 `xl.meta`，不是依赖目录里某一份完整文件。**

## 5 pool.bin：pool 生命周期账本，不是对象索引

`pool.bin` 容易让人误会。它在磁盘上看起来像一个特殊文件：

```text
.rustfs.sys/pool.bin/xl.meta
```

这里要拆成三层看：

1. 磁盘上看到的是 `xl.meta` 外壳；
2. 对象层读出来的是 `.rustfs.sys` bucket 里的 `pool.bin` 对象；
3. 对象 payload 是 RustFS 自己编码的 `PoolMeta`。

先看外壳。`pool.bin` 不是一个只存在于某台机器上的中心数据库文件；从 `xl.meta` 解码结果看，它走的是 RustFS 内部对象元数据路径，并且这个样本里数据被 inline 到 `xl.meta`。

```bash
cargo run -p rustfs-filemeta --example dump_fileinfo -- \
  node1/disk1/.rustfs.sys/pool.bin/xl.meta

cargo run -p rustfs-filemeta --example dump_fileinfo -- \
  node1/disk1/dist-bucket/dist-large-2m.bin/xl.meta
```

![RustFS dump_fileinfo 解码 pool.bin/xl.meta 和用户对象 xl.meta，pool.bin 显示 inline data 标记，用户对象显示逻辑大小 2097152 字节](https://img.f3dlife.com/blog/2026/06/29/rustfs-xlmeta-dump-89ae36b3-f4ac-4199-99f9-14fd94e45d82.png)
Fig. `pool.bin` 和用户对象都能按 `xl.meta` 解码；`pool.bin` 样本带有 `x-rustfs-internal-inline-data=true`，用户对象 `xl.meta` 记录逻辑大小 2097152 B。

用 RustFS 自带的 `dump_fileinfo` 例子解码后，`pool.bin` 更像是一个存放在 `.rustfs.sys` 下的内部对象：

```text
path: node1/disk1/.rustfs.sys/pool.bin/xl.meta
size: 234
etag: Some("951a7de075b3ec05f9e09e74bea75345")
parts: 1
part#0: number=1 size=234 actual_size=234 etag=951a7de075b3ec05f9e09e74bea75345
part#0.index: none
metadata entries: 3
meta[etag]=951a7de075b3ec05f9e09e74bea75345
meta[x-minio-internal-inline-data]=true
meta[x-rustfs-internal-inline-data]=true
```

对比用户对象的 `xl.meta`：

```text
path: node1/disk1/dist-bucket/dist-large-2m.bin/xl.meta
size: 2097152
etag: Some("a0e2aa19d5bf051548e8a2983a6ceeec")
parts: 1
part#0: number=1 size=2097152 actual_size=2097152 etag=a0e2aa19d5bf051548e8a2983a6ceeec
part#0.index: none
metadata entries: 2
meta[content-type]=application/octet-stream
meta[etag]=a0e2aa19d5bf051548e8a2983a6ceeec
```

两者都走 `xl.meta` 这套对象元数据格式。区别在语义：`pool.bin` 位于 `.rustfs.sys` 内部命名空间，RustFS 用它记录 pool 相关状态；用户不会把它当普通业务对象读写。

源码测试里也有针对 `.rustfs.sys/pool.bin` 的兼容解析用例，调用的是 `into_fileinfo(".rustfs.sys", "pool.bin", ...)`。
源码锚点：
[`crates/filemeta/src/filemeta.rs#L1144-L1165`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/filemeta/src/filemeta.rs#L1144-L1165)
说明 `pool.bin` 的磁盘外壳可以按 `xl.meta` 对象元数据路径解析。

再看对象层。`pool.bin` 这个名字来自 `POOL_META_NAME`，格式号和版本号也在同一个文件里定义：

```rust
pub const POOL_META_NAME: &str = "pool.bin";
pub const POOL_META_FORMAT: u16 = 1;
pub const POOL_META_VERSION: u16 = 1;
```

源码锚点：
[`crates/ecstore/src/pools.rs#L84-L86`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs#L84-L86)
定义 `pool.bin` 这个内部对象名，以及 pool metadata 的格式号和版本号。

读写它时，RustFS 没有直接打开某个本地路径，而是走 `read_config` / `save_config`。这两个函数固定使用 `RUSTFS_META_BUCKET`，也就是 `.rustfs.sys`：

```rust
pub async fn read_config<S: ObjectIO>(api: Arc<S>, file: &str) -> Result<Vec<u8>> {
    let (data, _obj) = read_config_with_metadata(api, file, &ObjectOptions::default()).await?;
    Ok(data)
}

pub async fn save_config<S: ObjectIO>(api: Arc<S>, file: &str, data: Vec<u8>) -> Result<()> {
    save_config_with_opts(
        api,
        file,
        data,
        &ObjectOptions {
            max_parity: true,
            ..Default::default()
        },
    )
    .await
}
```

源码里有两个锚点：
[`crates/ecstore/src/config/com.rs#L185-L241`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/config/com.rs#L185-L241)
负责配置对象的读写路径；
[`crates/ecstore/src/disk/mod.rs#L26`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/disk/mod.rs#L26)
定义内部命名空间常量 `.rustfs.sys`。两者连起来说明 `pool.bin` 写在内部对象路径下，而不是外部数据库。

所以 `pool.bin` 的“文件位置”不是它的完整语义。更准确地说，它是一个 RustFS config 对象：

```text
解释模型，不是原始输出:
bucket: .rustfs.sys
object: pool.bin
disk representation: .rustfs.sys/pool.bin/xl.meta
write path: save_config(pool, "pool.bin", bytes)
read path: read_config(pool, "pool.bin")
```

最后看 payload。`PoolMeta::save` 会先写 4 字节头部，再把 `PersistedPoolMeta` 用 MessagePack 编码进去：

```rust
let mut data = Vec::new();
data.write_u16::<LittleEndian>(POOL_META_FORMAT)?;
data.write_u16::<LittleEndian>(POOL_META_VERSION)?;
let mut buf = Vec::new();
PersistedPoolMeta::from(self).serialize(&mut Serializer::new(&mut buf))?;
data.write_all(&buf)?;

for pool in pools {
    save_config(pool, POOL_META_NAME, data.clone()).await?;
}
```

源码锚点：
[`crates/ecstore/src/pools.rs#L844-L857`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs#L844-L857)
说明保存 `pool.bin` 时会写入 4 字节头部，再序列化 `PersistedPoolMeta`，并保存到所有 pool。

`PoolMeta::load` 则反过来读取 `pool.bin`，校验前 4 字节的格式号和版本号，然后从 `data[4..]` 开始解 `PersistedPoolMeta`：

```rust
let format = LittleEndian::read_u16(&data[0..2]);
if format != POOL_META_FORMAT {
    return Err(Error::other(format!("pool metadata load failed: unknown format {format}")));
}
let version = LittleEndian::read_u16(&data[2..4]);
if version != POOL_META_VERSION {
    return Err(Error::other(format!("pool metadata load failed: unknown version {version}")));
}

*self = Self::decode_pool_meta_payload(&data[4..])?;
```

源码锚点：
[`crates/ecstore/src/pools.rs#L807-L841`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs#L807-L841)
说明加载 `pool.bin` 时会校验格式号、版本号，再从 `data[4..]` 解码 payload。

真正持久化的结构不是 `format.json` 里的 set 拓扑，而是 pool 状态数组：

```rust
struct PersistedPoolMeta {
    pub version: u16,
    pub pools: Vec<PersistedPoolStatus>,
}

struct PersistedPoolStatus {
    #[serde(rename = "id")]
    pub id: usize,
    #[serde(rename = "cmdline")]
    pub cmd_line: String,
    #[serde(rename = "lastUpdate", with = "time::serde::rfc3339")]
    pub last_update: OffsetDateTime,
    #[serde(rename = "decommissionInfo")]
    pub decommission: Option<PersistedPoolDecommissionInfo>,
}
```

源码锚点：
[`crates/ecstore/src/pools.rs#L590-L606`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs#L590-L606)
给出 `PersistedPoolMeta` 和 `PersistedPoolStatus` 的持久化结构。

如果 pool 正在 decommission，`decommissionInfo` 里还会持久化开始时间、容量进度、完成/失败/取消状态、待处理 bucket、已处理 bucket、当前 bucket/prefix/object，以及对象数和字节数统计。
源码锚点：
[`crates/ecstore/src/pools.rs#L608-L642`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs#L608-L642)
给出 `PersistedPoolDecommissionInfo` 的真实字段。

也就是说，`pool.bin` 的内容可以概括成：

```text
解释模型，不是原始 payload:
u16 little-endian: POOL_META_FORMAT = 1
u16 little-endian: POOL_META_VERSION = 1
messagepack(PersistedPoolMeta):
  version
  pools[]
    id
    cmdline
    lastUpdate
    decommissionInfo?
```

这段是解释模型，不是从 `pool.bin/xl.meta` 里直接打印出来的 JSON。已验证的是：磁盘外壳是 `xl.meta`，源码写入的 payload schema 是 `PersistedPoolMeta`，编码方式是 `rmp_serde` MessagePack。本文没有用对象读路径把实验样本的 `pool.bin` payload 反解成可读 JSON。

它在架构中的位置也因此清楚了：`format.json` 解决“这块盘是谁、属于哪个 set”；`pool.bin` 解决“当前有哪些 pool，以及这些 pool 的生命周期状态如何”。启动时，`ECStore::init` 会加载 `PoolMeta`，校验后写入运行时的 `ECStore.pool_meta`：

```rust
let mut meta = PoolMeta::default();
resolve_store_init_stage_result(
    meta.load(
        self.pools
            .first()
            .cloned()
            .ok_or_else(|| Error::other("store init failed: no storage pools available"))?,
        self.pools.clone(),
    )
    .await,
    "load_pool_meta",
)?;
let update = meta.validate(self.pools.clone())?;
```

源码锚点：
[`crates/ecstore/src/store/init.rs#L362-L374`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store/init.rs#L362-L374)
说明启动时会加载 `PoolMeta`，并对当前 pool 列表做校验。

在 decommission 路径里，RustFS 会更新 `pool_meta`，保存到所有 pool，然后通知其他节点 reload：

```rust
pool_meta.save(self.pools.clone()).await?;

if let Some(notification_sys) = get_global_notification_sys()
    && let Err(err) =
        resolve_decommission_pool_meta_reload_result(notification_sys.reload_pool_meta().await, "start_decommission")
{
    warn!("{err}");
}
```

源码锚点：
[`crates/ecstore/src/pools.rs#L2574-L2590`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs#L2574-L2590)
说明 decommission 启动时会更新并保存 `pool_meta`，随后通知其他节点 reload。

peer 侧的 reload 会重新从对象层加载 `pool.bin`，再替换内存里的 `pool_meta`：

```rust
pub async fn reload_pool_meta(&self) -> Result<()> {
    let mut meta = PoolMeta::default();
    resolve_store_rebalance_pool_meta_reload_result(
        meta.load(self.pools[0].clone(), self.pools.clone()).await,
        "reload_pool_meta",
    )?;

    let mut pool_meta = self.pool_meta.write().await;
    *pool_meta = meta;
    Ok(())
}
```

源码锚点：
[`crates/ecstore/src/store/rebalance.rs#L625-L635`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store/rebalance.rs#L625-L635)
说明 peer reload 会重新加载 `PoolMeta` 并替换内存中的 `pool_meta`。

把这些证据合起来，`pool.bin` 的语义栈是：

| 层 | 结论 |
| --- | --- |
| 位置 | `.rustfs.sys/pool.bin/xl.meta` 是磁盘上的对象元数据外壳 |
| 外层格式 | `xl.meta`；小对象样本里 payload inline 在元数据里 |
| 对象路径 | `.rustfs.sys` bucket 下的 `pool.bin` config 对象 |
| payload | 4 字节 little-endian 头部 + MessagePack 编码的 `PersistedPoolMeta` |
| 写入者 | 初始化校验需要更新时、decommission 状态变化时调用 `PoolMeta::save` |
| 读取者 | 启动和 peer reload 时调用 `PoolMeta::load` |
| 边界 | 不记录每个业务对象在哪里，也不替代 `format.json` 的磁盘身份和 set 布局 |

因此可以这样区分：

```text
解释模型，不是原始输出:
format.json
  local disk identity file
  plain JSON
  every disk has one

pool.bin
  internal RustFS object
  stored under .rustfs.sys
  represented on disk by xl.meta and possibly inline data
  payload = 4-byte header + MessagePack PersistedPoolMeta
  loaded into ECStore.pool_meta
```

**`format.json` 更像每块盘的身份证；`pool.bin` 更像 RustFS 自己存在对象层里的 pool 生命周期账本。** 它不是对象索引，也不决定某个业务对象进入哪个 set；对象定位仍然靠 deployment id、object name hash 和 set 布局。

## 6 纠删码边界：4+4、6+2、8+4 到底差在哪

实验里的 set 宽度是 8，对象被写成 8 个 `part.1`，每个 524352 B。逻辑对象是 2 MiB，8 个分片合计约 4 MiB，所以它符合 4+4 的空间直觉。

![RustFS 4+4 erasure set 中 4 个数据分片和 4 个校验分片跨 4 台机器 8 块盘放置，一台机器故障会同时丢失两块盘的 shard](https://img.f3dlife.com/blog/2026/06/29/rustfs-4plus4-failure-domain-f88eed71-9cca-466b-ade8-ffd271e237bb.svg)
Fig. 4+4 set 的故障域不是“机器数量”本身，而是 set 内丢失 shard 的数量；这个实验里每台机器在同一个 set 中有两块盘。

纠删码利用率可以先用一个简单公式理解：

```text
解释模型，不是原始输出:
usable = data_shards / (data_shards + parity_shards)
```

| 组合 | set 宽度 | 利用率 | 单个 set 内最多容忍缺失 shard |
| --- | ---: | ---: | ---: |
| 4+4 | 8 | 50.0% | 4 |
| 4+2 | 6 | 66.7% | 2 |
| 6+2 | 8 | 75.0% | 2 |
| 8+4 | 12 | 66.7% | 4 |

这里最容易踩的坑是把 `6+2` 解释成“最多坏两台机器”。严格说，它最多容忍的是同一个 set 内缺失 2 个 shard。

如果一个 set 横跨 8 台机器，每台机器只放这个 set 的 1 块盘，那么坏 2 台机器确实等价于丢 2 个 shard。

但在这个实验拓扑里，4 台机器 × 每台 2 块盘，且这 8 块盘都在同一个 set 中。一台机器掉线就可能丢 2 个 shard；两台机器掉线就可能丢 4 个 shard。对于 6+2，这已经超过 parity 数。

**机器级容灾不是只看 `+2` 或 `+4`，还要看 set 内 shard 如何跨机器摆放。**

4+2 和 8+4 的利用率都约等于 66.7%，但它们也不等价：

- 4+2 的 set 更小，读写扇出更少，恢复影响面也更小；
- 8+4 的 set 更大，最多容忍 4 个 shard 缺失，但每个对象牵涉更多盘，慢盘和恢复的影响面更大。

所以选纠删码配置时，先问两个问题：这个 set 横跨多少台机器？一次机器级故障会让这个 set 丢几个 shard？

## 7 pool、set 与扩容/坏槽位

pool 是容量和迁移的管理单位，set 是对象哈希和纠删码的工作边界。

这两个概念放在一起，才能解释扩容和坏槽位问题。

已有 pool 的 set 几何形状不是随手改变的。比如一个 pool 已经由若干个 8 盘 set 组成，它不是简单加一块盘就把旧 set 变成 9 盘 set。新增容量通常体现为新增 pool，再通过迁移、rebalance 或 decommission 类流程改变数据分布。

源码里 endpoint 展开和 set 分组也体现了“先根据 volumes 形成 endpoint list，再按 set size 切成 set”的模型：

```rust
pub fn from_volumes<T: AsRef<str>>(args: &[T], set_drive_count: usize) -> Result<Self> {
    let mut arg_patterns = Vec::with_capacity(args.len());
    for arg in args {
        arg_patterns.push(find_ellipses_patterns(arg.as_ref())?);
    }

    let total_sizes = get_total_sizes(&arg_patterns);
    let set_indexes = get_set_indexes(args, &total_sizes, set_drive_count, &arg_patterns)?;

    let mut endpoints = Vec::new();
    for ap in arg_patterns.iter() {
        let aps = ap.expand();
        for bs in aps {
            endpoints.push(bs.join(""));
        }
    }

    Ok(EndpointSet {
        set_indexes,
        _arg_patterns: arg_patterns,
        endpoints,
    })
}
```

源码锚点：
[`crates/ecstore/src/disks_layout.rs#L262-L283`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/disks_layout.rs#L262-L283)
说明 endpoint 会从 volumes 展开，再按 set drive count 形成 set 分组。

这带来几个实践判断：

1. 如果一个硬盘槽位坏了，且不能在同一位置恢复可用 endpoint，原 set 会持续带着这个风险。
2. 新增 pool 可以接收新写入或迁移后的数据，但它不会神奇修好旧 set 的故障域。
3. 把 pool 粒度切得很小，比如“一个 set 一个 pool”，可以让隔离更细，但也会增加容量均衡、迁移和运维观察成本。
4. 更关键的不是 pool 多小，而是每个 set 的 shard 是否按期望跨机器、跨机架或跨故障域分布。

更稳定的工作模型是：pool 是“容量生命周期单位”，set 是“对象放置和故障容忍单位”。这两个边界不要混着看。

## 8 小结

把启动路径、写入路径和元数据持久化放在一起，可以得到这个工作模型：

```text
解释模型，不是原始输出:
startup path:
  RUSTFS_VOLUMES
    -> endpoint list
    -> local/remote disk mapping
    -> read or create format.json
    -> pool / set / disk view

object PUT path:
  object name
    -> hash to set
    -> erasure encode inside the set
    -> write xl.meta and part.N shards

metadata persistence:
  format.json = per-disk identity and set layout
  pool.bin = internal PoolMeta object under .rustfs.sys
  pool.bin payload = 4-byte header + MessagePack PersistedPoolMeta
  xl.meta = object metadata and sometimes inline data
```

实验输出已经验证：8 块盘都有 `format.json`，同一个 deployment id 下有不同 `this`；2 MiB 对象在 4+4 下写成 8 个 shard；`pool.bin` 可以按内部对象的 `xl.meta` 解码。源码路径进一步说明：它的 payload 是 `PoolMeta`，用于记录 pool 生命周期状态，不是业务对象索引。

还有一些没有在这篇里展开：比如 rebalance/decommission 的完整状态机、远端 disk RPC 的认证与读写路径、坏盘 heal 时如何选择参考 format。这些更适合单独拆成后续文章。

这篇先停在一个结论上：**RustFS 的“自描述”不是没有集群拓扑，而是把稳定拓扑写进每块盘的 `format.json`，再用启动参数、format quorum、对象哈希和 `xl.meta` 在运行时重建对象存储视图。**

## 参考资料

- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`rustfs/src/config/cli.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/rustfs/src/config/cli.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/store_init.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store_init.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/store/init.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store/init.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/pools.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/pools.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/config/com.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/config/com.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/store/rebalance.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store/rebalance.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/sets.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/sets.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/disks_layout.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/disks_layout.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/filemeta/src/filemeta.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/filemeta/src/filemeta.rs)
- 实验命令：`cargo run -p rustfs-filemeta --example dump_fileinfo -- <xl.meta>`
