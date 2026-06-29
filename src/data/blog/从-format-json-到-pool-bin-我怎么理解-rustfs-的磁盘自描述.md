---
title: "图解 RustFS 磁盘自描述：从 format.json 到 pool.bin（2026）"
author: F3D
pubDatetime: 2026-06-29T15:23:56+08:00
description: "沿一次 4 节点 8 磁盘实验，追踪 RustFS 如何用 RUSTFS_VOLUMES、format.json、set 和 xl.meta 定位对象。"
tags:
  - release
  - rustfs
  - storage
  - rust
draft: false
---

RustFS 的 `.rustfs.sys/` 目录里，有两个很容易误判的对象：每盘一份的 `format.json`，以及看起来像系统元数据的 `pool.bin/xl.meta`。

如果只看目录结构，很容易把它们理解成某种中心元数据。但从启动拓扑、磁盘身份、对象 hash 和 `xl.meta/part.N` 的关系看，RustFS 的恢复模型更像一组分层规则。

本文沿两条路径展开：启动路径解释节点如何恢复 pool/set/disk 视图；对象写入路径解释一个 PUT 如何落到 set 内的 `xl.meta` 和 `part.1`。

实验拓扑：RustFS 源码 `main@acdf43937162b247619c6a32a5fe079146ca794d`，4 个节点，每个节点 2 块盘，一共 8 个 disk endpoint。实验形成 1 个 pool、1 个 set，上传一个 2 MiB 对象后观察磁盘文件和源码路径。

![RustFS PUT 请求从 S3 客户端进入任意节点，再根据 RUSTFS_VOLUMES、format.json 和对象名哈希写入 pool 0 set 0 的 8 个磁盘分片](https://img.f3dlife.com/blog/2026/06/29/rustfs-put-topology-388bbda3-130a-4b8d-9a25-0627fadaa360.svg)
Fig. RustFS 4 节点 8 磁盘实验拓扑：`RUSTFS_VOLUMES` 给出 endpoint 列表，`format.json` 给出磁盘身份和 set 布局，对象名哈希选择 set，`xl.meta/part.1` 保存对象元数据和分片。

## 目录

- [1 问题与环境](#1-问题与环境)
- [2 先看磁盘上真实出现了什么](#2-先看磁盘上真实出现了什么)
- [3 启动路径：RUSTFS_VOLUMES 和 format.json 如何拼出拓扑](#3-启动路径rustfs_volumes-和-formatjson-如何拼出拓扑)
- [4 写入路径：对象如何进入 set](#4-写入路径对象如何进入-set)
- [5 pool.bin：内部对象，不是中心数据库](#5-poolbin内部对象不是中心数据库)
- [6 纠删码边界：4+4、6+2、8+4 到底差在哪](#6-纠删码边界4484-到底差在哪)
- [7 pool、set 与扩容/坏槽位](#7-poolset-与扩容坏槽位)
- [8 小结](#8-小结)
- [参考资料](#参考资料)

## 1 问题与环境

本文只验证三类证据：磁盘上的真实文件、`xl.meta` 解码输出、RustFS 源码里的启动和 set 选择入口。不覆盖 rebalance/decommission 的完整状态机。

要回答的问题是：

1. 节点从哪里知道集群有哪些磁盘？
2. 每块盘怎么证明“我属于这个部署、我是 set 里的第几块盘”？
3. 一个对象怎么从名字映射到某个 set？
4. `pool.bin` 是中心元数据，还是内部对象？
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

下面所有输出都来自这个实验环境；涉及本机目录的部分已经裁成实验拓扑相对路径。

## 2 先看磁盘上真实出现了什么

上传对象之后，8 块盘上都出现了三类关键文件：

```text
node1/disk1/.rustfs.sys/format.json 498 bytes
node1/disk1/.rustfs.sys/pool.bin/xl.meta 537 bytes
node1/disk1/dist-bucket/dist-large-2m.bin/xl.meta 413 bytes
...
node4/disk2/.rustfs.sys/format.json 498 bytes
node4/disk2/.rustfs.sys/pool.bin/xl.meta 537 bytes
node4/disk2/dist-bucket/dist-large-2m.bin/xl.meta 413 bytes
```

对象的数据分片也在 8 块盘上各有一份：

```text
node1/disk1/.../part.1 524352 bytes
node1/disk2/.../part.1 524352 bytes
node2/disk1/.../part.1 524352 bytes
node2/disk2/.../part.1 524352 bytes
node3/disk1/.../part.1 524352 bytes
node3/disk2/.../part.1 524352 bytes
node4/disk1/.../part.1 524352 bytes
node4/disk2/.../part.1 524352 bytes
```

这组数字先给出一个直觉：

```text
2 MiB 逻辑对象
  -> 8 个 part.1
  -> 每个 part.1 524352 B
  -> 合计约 4 MiB
```

这不是 8 份完整复制，而是 4+4 纠删码：4 个 data shard，4 个 parity shard。**对象恢复依赖 set 内的 shard 和 `xl.meta`，不是依赖目录里某一份完整文件。**

## 3 启动路径：RUSTFS_VOLUMES 和 format.json 如何拼出拓扑

先看入口。RustFS server 的 volumes 参数来自命令行或环境变量 `RUSTFS_VOLUMES`。源码里 `ServerOpts.volumes` 标了 `env = "RUSTFS_VOLUMES"`，并用空格拆分 endpoint 列表：

```rust
#[arg(
    required = true,
    env = "RUSTFS_VOLUMES",
    value_delimiter = ' ',
    value_parser = NonEmptyStringValueParser::new()
)]
pub volumes: Vec<String>,
```

证据锚点：`rustfs/src/config/cli.rs` 第 172-182 行。

也就是说，多机部署不是靠节点随便广播“我要加入哪个集群”。更准确的模型是：

```text
all nodes receive the same RUSTFS_VOLUMES
  -> parse endpoint list
  -> decide local endpoints vs remote endpoints
  -> read or create per-disk format.json
  -> build pool / set / disk mapping
```

`RUSTFS_VOLUMES` 给出预期拓扑，但它本身还不足以说明“这块盘是谁”。磁盘身份落在 `.rustfs.sys/format.json`。

实验里抽取一块盘的 `format.json`，关键信息是：

```json
{
  "version": "1",
  "format": "xl",
  "id": "13c779ee-1cf5-4b6d-bbfd-8c5298e04e2e",
  "this": "63124b32-a325-4072-9b45-e56a8eb6ae75",
  "setCount": 1,
  "setWidths": [8],
  "distributionAlgo": "SIPMOD+PARITY"
}
```

这里为了阅读方便，`xl.sets` 这个 UUID 矩阵被折叠成了 `setCount/setWidths`。真实文件里，`xl.sets[0]` 记录了这个 set 的 8 个 disk UUID；`xl.this` 则是当前这块盘自己的 UUID。

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

证据锚点：`crates/ecstore/src/store_init.rs` 第 130-152 行。

所以 RustFS 的“磁盘自描述”不是说每块盘保存了所有动态状态，而是说每块盘保存了足够稳定的身份和布局信息：

```text
deployment id: 我属于哪个部署
this: 我是哪块盘
sets: 这个 pool 的 set 矩阵长什么样
distributionAlgo: 对象分布算法是什么
```

**启动时，`RUSTFS_VOLUMES` 是拓扑输入，`format.json` 是磁盘身份账本。两者对得上，节点才能恢复出同一套 pool/set/disk 视图。**

## 4 写入路径：对象如何进入 set

有了 pool/set/disk 视图之后，对象写入还需要解决另一个问题：这个 object key 进入哪个 set？

RustFS 在 `Sets` 里有一个很直接的路径：

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

证据锚点：`crates/ecstore/src/sets.rs` 第 287-340 行。

这段代码说明两件事。

第一，set 选择不是扫描目录得出的，而是由 object key 确定性哈希得出的。

第二，实验里的 `distributionAlgo` 是 `SIPMOD+PARITY`，对应 V2/V3 的 sip hash 路径；hash key 用的是 deployment id。

这个实验里只有一个 set，所以所有对象都会落到 set 0。但在多个 set 的 pool 中，路径会变成：

```text
object name
  -> sip_hash(object_name, set_count, deployment_id)
  -> set index
  -> set disks
  -> xl.meta + part.N shards
```

这也是为什么“只看目录”会误导：目录是写入后的形态，不是对象定位的规则。对象先通过 hash 进入某个 set，再在 set 内按纠删码布局写出 `xl.meta` 和 `part.1`。

## 5 pool.bin：内部对象，不是中心数据库

`pool.bin` 容易让人误会。它在磁盘上看起来像一个特殊文件：

```text
.rustfs.sys/pool.bin/xl.meta
```

但用 RustFS 自带的 `dump_fileinfo` 例子解码后，它更像是一个存放在 `.rustfs.sys` 下的内部对象：

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

源码测试里也有针对 `.rustfs.sys/pool.bin` 的兼容解析用例，调用的是 `into_fileinfo(".rustfs.sys", "pool.bin", ...)`。证据锚点：`crates/filemeta/src/filemeta.rs` 第 1144-1165 行。

因此可以这样区分：

```text
format.json
  local disk identity file
  plain JSON
  every disk has one

pool.bin
  internal RustFS object
  stored under .rustfs.sys
  represented by xl.meta and possibly inline data
```

**`format.json` 更像每块盘的身份证；`pool.bin` 更像 RustFS 自己存在对象层里的 pool 状态文件。**

## 6 纠删码边界：4+4、6+2、8+4 到底差在哪

实验里的 set 宽度是 8，对象被写成 8 个 `part.1`，每个 524352 B。逻辑对象是 2 MiB，8 个分片合计约 4 MiB，所以它符合 4+4 的空间直觉。

![RustFS 4+4 erasure set 中 4 个数据分片和 4 个校验分片跨 4 台机器 8 块盘放置，一台机器故障会同时丢失两块盘的 shard](https://img.f3dlife.com/blog/2026/06/29/rustfs-4plus4-failure-domain-4dda7041-075e-493f-8e75-727cb0729cc9.svg)
Fig. 4+4 set 的故障域不是“机器数量”本身，而是 set 内丢失 shard 的数量；这个实验里每台机器在同一个 set 中有两块盘。

纠删码利用率可以先用一个简单公式理解：

```text
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
    ...
}
```

证据锚点：`crates/ecstore/src/disks_layout.rs` 第 262-283 行。

这带来几个实践判断：

1. 如果一个硬盘槽位坏了，且不能在同一位置恢复可用 endpoint，原 set 会持续带着这个风险。
2. 新增 pool 可以接收新写入或迁移后的数据，但它不会神奇修好旧 set 的故障域。
3. 把 pool 粒度切得很小，比如“一个 set 一个 pool”，可以让隔离更细，但也会增加容量均衡、迁移和运维观察成本。
4. 更关键的不是 pool 多小，而是每个 set 的 shard 是否按期望跨机器、跨机架或跨故障域分布。

更稳定的工作模型是：pool 是“容量生命周期单位”，set 是“对象放置和故障容忍单位”。这两个边界不要混着看。

## 8 小结

把启动路径、写入路径和元数据持久化放在一起，可以得到这个工作模型：

```text
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
  pool.bin = internal object under .rustfs.sys
  xl.meta = object metadata and sometimes inline data
```

实验输出已经验证：8 块盘都有 `format.json`，同一个 deployment id 下有不同 `this`；2 MiB 对象在 4+4 下写成 8 个 shard；`pool.bin` 可以按内部对象的 `xl.meta` 解码。

还有一些没有在这篇里展开：比如 rebalance/decommission 的完整状态机、远端 disk RPC 的认证与读写路径、坏盘 heal 时如何选择参考 format。这些更适合单独拆成后续文章。

这篇先停在一个结论上：**RustFS 的“自描述”不是没有集群拓扑，而是把稳定拓扑写进每块盘的 `format.json`，再用启动参数、format quorum、对象哈希和 `xl.meta` 在运行时重建对象存储视图。**

## 参考资料

- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`rustfs/src/config/cli.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/rustfs/src/config/cli.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/store_init.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/store_init.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/sets.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/sets.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/ecstore/src/disks_layout.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/ecstore/src/disks_layout.rs)
- RustFS source `acdf43937162b247619c6a32a5fe079146ca794d`: [`crates/filemeta/src/filemeta.rs`](https://github.com/SonglinLife/rustfs/blob/acdf43937162b247619c6a32a5fe079146ca794d/crates/filemeta/src/filemeta.rs)
- 实验命令：`cargo run -p rustfs-filemeta --example dump_fileinfo -- <xl.meta>`
