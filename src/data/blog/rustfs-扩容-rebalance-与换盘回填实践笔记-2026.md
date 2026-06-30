---
title: "RustFS 扩容、Rebalance 与换盘回填实践笔记（2026）"
author: F3D
pubDatetime: 2026-06-30T16:41:10+08:00
description: "用一个 8 节点 16 磁盘实验观察 RustFS 新增 pool、post-expansion rebalance、坏盘换盘回填和缩容边界。"
tags:
  - release
  - rustfs
  - storage
  - infrastructure
draft: false
---

RustFS 的扩缩容边界容易被误判：看起来集群里有 node、disk、set、pool 好几层对象，但真正暴露给运维的容量生命周期单位是 **server pool**。

这篇沿一个本地实验走完整条路径：先从 4 node / 8 disk 写入对象，再新增第二个 pool，启动 post-expansion rebalance，观察对象文件怎么流向新 pool；最后模拟一块盘损坏并换空盘，看 RustFS 如何把缺失 shard 回填回来。

实验使用 RustFS `1.0.0-beta.8`，CLI `rc v0.1.25`。拓扑是 8 个容器节点，每个节点 2 块 loopback ext4 磁盘。loopback 不是为了模拟性能，而是为了让 RustFS 看到每块盘都是独立设备；普通 bind mount 在同一个宿主文件系统上，会影响容量统计和 rebalance 判断。

![RustFS expansion workflow with pool 0 node1 to node4, pool 1 node5 to node8, rebalance moving object shards, and node5 disk replacement healing](https://img.f3dlife.com/blog/2026/06/30/expansion-rebalance-topology-95df4aaa-0353-4f11-8ac2-73bdf124fe9c.svg)
Fig. RustFS 扩容与回填路径：对象先写入 `pool 0`，`rc admin expand start` 触发 post-expansion rebalance，把一部分对象 shard 写到 `pool 1`；换掉 `node5/disk1` 后，同一 erasure set 的其他磁盘把缺失 shard 回填到新盘。

## 目录

- [1 问题与环境](#1-问题与环境)
- [2 扩容边界：新增的是 pool，不是 set](#2-扩容边界新增的是-pool不是-set)
- [3 Step 1：先构造 4 node / 1 pool 的旧数据](#3-step-1先构造-4-node--1-pool-的旧数据)
- [4 Step 2：新增第二个 pool](#4-step-2新增第二个-pool)
- [5 Step 3：启动 rebalance 并观察数据流动](#5-step-3启动-rebalance-并观察数据流动)
- [6 Step 4：坏盘、换盘与数据回填](#6-step-4坏盘换盘与数据回填)
- [7 缩容边界：decommission pool，不是移除 set](#7-缩容边界decommission-pool不是移除-set)
- [8 小结](#8-小结)
- [参考资料](#参考资料)

## 1 问题与环境

这篇只回答四个问题：

1. RustFS 扩容时新增的对象是什么？
2. post-expansion rebalance 到底有没有搬旧数据？
3. 坏一块盘并换空盘后，磁盘上的对象文件怎么变化？
4. 如果缩容，边界是 pool 还是 set？

实验环境如下：

| 项目 | 值 |
| --- | --- |
| RustFS | `rustfs/rustfs:latest`，容器内版本 `1.0.0-beta.8` |
| CLI | `rc v0.1.25` |
| 初始拓扑 | 4 node，每 node 2 disk，1 pool |
| 扩容后拓扑 | 8 node，每 node 2 disk，2 pool |
| 磁盘形态 | 每个 disk 是独立 loopback ext4 |
| 测试 bucket | `rebalance-demo` |
| 测试对象 | `before-expand/obj-000.bin` 到 `obj-095.bin` |
| 逻辑数据量 | 96 个对象，每个 2 MiB，共 192 MiB |

先看一个实验边界。最初如果直接把多个目录 bind mount 到容器里，它们在宿主机上其实都属于同一个文件系统。`stat` 能看到所有目录的 `st_dev` 一样：

```text
node1/disk1 st_dev=64771
node5/disk1 st_dev=64771
```

这种布局能演示“新增 pool”，但不适合观察 rebalance。RustFS 看到两个 pool 的容量统计会非常接近，rebalance 可能创建任务但没有实际迁移：

```json
{
  "status": "None",
  "progress": null
}
```

所以正式实验改成每块盘一个 loopback ext4。这里要验证的是：RustFS 看到的 16 个 disk endpoint 不是同一个宿主文件系统上的 16 个目录，而是 16 个不同的设备。

```bash
stat -c '%n st_dev=%d' node{1..8}/disk{1..2}
```

![Sixteen RustFS loopback disks have different st_dev values from node1 disk1 through node8 disk2](https://img.f3dlife.com/blog/2026/06/30/loop-devices-c579db9b-d97e-4842-9c8d-1a902cb2147d.png)
Fig. 16 个实验 disk 的 `st_dev` 都不同；这个条件让 pool 容量统计和 rebalance 判断更接近真实多盘环境。

**要观察 rebalance，测试盘至少要让 RustFS 看到独立容量和独立设备。** 否则看到的是本地实验环境的假象，不是 RustFS 的迁移行为。

## 2 扩容边界：新增的是 pool，不是 set

RustFS 的扩容方式是新增 server pool。这个结论可以从启动参数和 CLI 两侧验证。

初始 4 node / 8 disk 的 `RUSTFS_VOLUMES` 是：

```text
http://node{1...4}:9000/data{1...2}
```

扩容到 8 node / 16 disk 后，不是在原 pool 里追加某个 set，而是把启动参数改成两个 pool：

```text
http://node{1...4}:9000/data{1...2} http://node{5...8}:9000/data{1...2}
```

这里有一个很实际的坑：如果初始集群用的是完全展开的 endpoint 列表，后面再把 16 个 endpoint 平铺到一起，RustFS 可能把它理解成单个 pool 的布局变化，而不是新增 pool。实验中平铺 16 个 endpoint 触发过格式不匹配：

```text
formats length for erasure.sets does not match: got 16, expected 8
```

用 ellipses 表达式初始化初始 pool，可以让后续新增 pool 的边界清楚很多：

```text
pool 0: http://node{1...4}:9000/data{1...2}
pool 1: http://node{5...8}:9000/data{1...2}
```

CLI 看到的也是 pool：

```bash
rc admin pool list local --json
```

扩容后输出中出现两个 active pool：

```json
{
  "pools": [
    {
      "id": 0,
      "cmdline": "http://node{1...4}:9000/data{1...2}",
      "status": "active"
    },
    {
      "id": 1,
      "cmdline": "http://node{5...8}:9000/data{1...2}",
      "status": "active"
    }
  ]
}
```

这说明扩容路径可以先按这个模型理解：

```text
old cluster
  pool 0

after expansion
  pool 0
  pool 1

post-expansion rebalance
  move some existing objects from pool 0 to pool 1
```

## 3 Step 1：先构造 4 node / 1 pool 的旧数据

实验先只启动 `node1..node4`：

```text
RUSTFS_VOLUMES=http://node{1...4}:9000/data{1...2}
```

然后写入 96 个对象：bucket 是 `rebalance-demo`，prefix 是 `before-expand/`，每个对象 2 MiB。这里要验证的是：对象写入之后，旧 pool 有对象文件，新 pool 还没有参与承载这些对象。

```bash
python3 put-96-objects.py
du -sh node*/disk*
find node{1..4} -path '*rebalance-demo*before-expand*' -type f | wc -l
find node{5..8} -path '*rebalance-demo*before-expand*' -type f | wc -l
```

![Before expansion the S3 write check shows 96 objects, old pool disks are 50M each, new pool disks are 20K each, and file counts are 1536 versus 0](https://img.f3dlife.com/blog/2026/06/30/before-expansion-0ef0ba1c-03f1-4311-bc21-e6fa74f2e5b2.png)
Fig. 扩容前基线：96 个对象都在 `node1..node4` 的旧 pool；`node5..node8` 仍是空盘，`new_pool_files=0`。

这里的 `1536` 来自 96 个对象在 8 块盘上的文件展开。每个对象在每块盘上有一个 `xl.meta` 和一个 `part.1`：

```text
96 objects * 8 disks * 2 files = 1536 files
```

实际对象路径长这样；截图里为了避免路径过长，`<data-dir>` 表示对象数据目录 UUID：

```text
node1/disk1/rebalance-demo/before-expand/obj-000.bin/<data-dir>/part.1
node1/disk1/rebalance-demo/before-expand/obj-000.bin/xl.meta
node1/disk1/rebalance-demo/before-expand/obj-001.bin/<data-dir>/part.1
node1/disk1/rebalance-demo/before-expand/obj-001.bin/xl.meta
```

这个状态是后面观察数据流动的基线：**所有测试对象都还在旧 pool。**

## 4 Step 2：新增第二个 pool

新增 pool 的动作是：准备 `node5..node8` 的磁盘，然后所有节点用新的 `RUSTFS_VOLUMES` 同时启动：

```text
RUSTFS_VOLUMES=http://node{1...4}:9000/data{1...2} http://node{5...8}:9000/data{1...2}
```

这一步完成后，`rc admin pool list` 能看到两个 pool。这里要验证三件事：pool 0 和 pool 1 都是 active；旧对象仍然可读；还没有 rebalance 时，新 pool 仍然没有旧对象文件。

```bash
rc admin pool list local --json
python3 read-sample-objects.py
du -sh node*/disk*
find node{1..4} -path '*rebalance-demo*before-expand*' -type f | wc -l
find node{5..8} -path '*rebalance-demo*before-expand*' -type f | wc -l
```

![After adding pool, pool 0 usedSize is 208322560, pool 1 usedSize is 294912, S3 reads 96 objects, and new_pool_files remains 0](https://img.f3dlife.com/blog/2026/06/30/after-add-pool-c20173e1-7315-4d8f-919b-1e6e4337c69c.png)
Fig. 新增 pool 后、rebalance 前：两个 pool 都 active，但旧对象仍只在 `pool 0`；`pool 1` 的对象文件计数还是 0，磁盘占用只有 68K。

这一步只是把新 pool 加入集群，并没有自动把旧对象平均搬过去。

## 5 Step 3：启动 rebalance 并观察数据流动

post-expansion rebalance 用的是：

```bash
rc admin expand start local
```

启动之后连续采样。这里要验证的是：rebalance 状态里记录了处理对象数，同时新 pool 里真的出现 `before-expand` 对象文件。

```bash
rc admin expand start local
rc admin expand status local --json
du -sh node*/disk*
find node{1..4} -path '*rebalance-demo*before-expand*' -type f | wc -l
find node{5..8} -path '*rebalance-demo*before-expand*' -type f | wc -l
```

![Expand rebalance starts successfully, reports 50 objects and 209715200 bytes, and file counts change from old 1536 new 0 to old 736 new 800](https://img.f3dlife.com/blog/2026/06/30/rebalance-flow-15e9c1c7-2c21-435d-b1d7-6056b63f414f.png)
Fig. rebalance 的直接证据：`progress.objects=50`，新 pool 文件数从 0 变成 800，并出现 `node5/disk1/.../obj-000.bin/.../part.1`。

也就是说，96 个旧对象里有 50 个被迁移到新 pool，剩下 46 个留在旧 pool。`800` 这个文件数也能对上：50 个对象，每个对象在 8 块盘上各有 `xl.meta` 和 `part.1`。

```text
50 objects * 8 disks * 2 files = 800 files
```

磁盘占用也从几乎空盘变成了有对象 shard：`node5..node8` 从每盘 68K 变成每盘 26M。旧 pool 没有被清空，`node1..node4` 仍然保留对象数据。

这里有一个重要结论：**post-expansion rebalance 不是把旧 pool 清空，而是把一部分已有对象重新分布到新增 pool。** 在这个实验里，迁移了 50 个对象，留下 46 个对象，两个 pool 都继续承载数据。

S3 视角没有变化，所有 96 个对象仍然可读。采样里同时读了迁移到新 pool 的 `obj-000.bin`、rebalance 末尾的 `obj-049.bin`，以及仍留在旧 pool 的 `obj-050.bin`、`obj-095.bin`：

```text
key_count=96
before-expand/obj-000.bin 1fba58466881b4e0c1ca1d6a155ca0cf
before-expand/obj-049.bin 94429dc9a54ceb834a49a4ff42678cc2
before-expand/obj-050.bin 1d1cb535430350d683418be3adeec660
before-expand/obj-095.bin 7cc6a4a685a610453618c8b0fbe33cbc
```

从对象层看，rebalance 改的是对象所在 pool 和底层 shard 文件位置；从 S3 API 看，对象 key、bucket 和读取结果保持稳定。

## 6 Step 4：坏盘、换盘与数据回填

换盘实验选 `node5/disk1`。这块盘属于新 pool，rebalance 后上面有 50 个对象的 shard。

模拟坏盘和换盘的流程是：

```text
1. 停止 rustfs-dist-node5
2. 卸载 node5/disk1
3. 用新的空 ext4 loopback 镜像替换原磁盘
4. 重新挂载到 node5/disk1
5. 启动 rustfs-dist-node5
```

这里要验证的是：换盘前这块盘有 shard，换空盘后变成 0 个对象文件，node5 重新加入后 shard 又被写回新盘，同时 S3 读取仍然正确。

```bash
du -sh node5/disk1
find node5/disk1 -path '*rebalance-demo/before-expand/obj-*.bin/*' -type f | wc -l

docker rm -f rustfs-dist-node5
umount node5/disk1
# replace node5 disk1 with a fresh ext4 loopback image
mount -o loop node5-disk1.img node5/disk1
docker run ... rustfs-dist-node5
```

![Disk replacement evidence shows node5 disk1 moving from 26M and 100 files to empty 20K and 0 files, then back to 26M and 100 files after node5 rejoins](https://img.f3dlife.com/blog/2026/06/30/disk-replacement-heal-3bb8b313-0fcb-446c-a9cc-217981dc2fed.png)
Fig. 换盘回填证据：`node5/disk1` 从 26M/100 个对象文件变成 20K/0 个对象文件；node5 重新加入后恢复到 26M/100 个对象文件，并且 S3 读校验仍然正确。

这个变化说明，单盘缺失时，只要同一 erasure set 的其他 shard 仍然满足恢复条件，RustFS 可以把缺失的 `part.1` 和 `xl.meta` 重新写到新盘上。

实验里还观察到一个细节：手动执行 `rc admin heal start` 前，回填已经发生了。`rc admin heal status` 当时显示没有正在运行的手动 heal：

```json
{
  "healing": false,
  "healQueueLength": 0,
  "healActiveTasks": 0,
  "itemsScanned": 0,
  "itemsHealed": 0
}
```

因此这次看到的回填更像节点重新加入后触发的自动修复或 read repair，而不是手动 heal 命令的结果。这里不把它扩展成完整 heal 状态机结论，只记录实验事实：

```text
empty replacement disk
  -> node rejoins
  -> missing object shards are recreated
  -> S3 reads stay correct
```

## 7 缩容边界：decommission pool，不是移除 set

扩容是新增 pool，缩容对应的是 decommission pool。CLI 的 help 文本很直接：

```text
Manage server pool decommissioning
```

启动 decommission 的命令参数也是 `<POOL>`：

```text
Usage: rc admin decommission start [OPTIONS] <ALIAS> <POOL>

Arguments:
  <ALIAS>  Alias name of the server
  <POOL>   Pool command line, comma-separated pool command lines, or zero-based pool ID with --by-id
```

也就是说，缩容的操作对象是：

```text
pool 0: http://node{1...4}:9000/data{1...2}
pool 1: http://node{5...8}:9000/data{1...2}
```

不是：

```text
某一个 erasure set
某几块 disk
某几个 node
```

set 是 pool 内部的对象放置和纠删码边界。它决定一个对象写入时在哪组磁盘里切 shard、恢复时从哪组磁盘重建缺失 shard；但容量生命周期操作暴露出来的是 pool。

因此可以把边界写成下面这样：

```text
扩容:
  add server pool

扩容后均衡:
  post-expansion rebalance between pools

坏盘:
  replace disk, then heal missing shards inside the affected set

缩容:
  decommission server pool
```

在这个模型下，如果要缩掉 `node5..node8` 这组容量，目标是 decommission `pool 1`。等数据从这个 pool 迁出并完成生命周期状态更新后，再从部署配置里移除这个 pool 并重启。不能把一个 pool 内部的某个 set 当成缩容对象单独摘掉。

## 8 小结

这次实验可以得到四条机制结论。

第一，RustFS 的横向扩容单位是 server pool。新增容量时，新的 `RUSTFS_VOLUMES` 不是把所有 endpoint 平铺成一个更大的旧 pool，而是表达成多个 pool：

```text
http://node{1...4}:9000/data{1...2} http://node{5...8}:9000/data{1...2}
```

第二，post-expansion rebalance 会把一部分旧对象迁到新增 pool。实验里 96 个对象中有 50 个进入新 pool，`node5..node8` 从每盘 68K 变成每盘 26M；S3 读对象保持不变。

第三，坏盘换空盘后，缺失 shard 可以被回填。实验里 `node5/disk1` 从 26M 变成 20K，再在 node5 重新加入后恢复到 26M，50 个对象的 `part.1` 和 `xl.meta` 重新出现。

第四，缩容不是按 set 做，而是按 pool 做 decommission。set 是 pool 内部的纠删码和对象放置边界，pool 才是扩容、rebalance、decommission 这些容量生命周期动作的边界。

这几个边界合在一起，RustFS 的容量操作可以用一句话概括：**pool 管容量生命周期，set 管对象放置和恢复。**

## 参考资料

- RustFS CLI `rc v0.1.25`：`admin pool`、`admin expand`、`admin heal`、`admin decommission` help 输出。
- RustFS `1.0.0-beta.8` 本地 Docker 实验输出：8 node / 16 loopback ext4 disks，`rebalance-demo/before-expand/` 对象分布、rebalance 状态和换盘回填结果。
- 站内前文：[图解 RustFS 磁盘自描述：从 format.json 到 pool.bin（2026）](/posts/从-format-json-到-pool-bin-我怎么理解-rustfs-的磁盘自描述/)
