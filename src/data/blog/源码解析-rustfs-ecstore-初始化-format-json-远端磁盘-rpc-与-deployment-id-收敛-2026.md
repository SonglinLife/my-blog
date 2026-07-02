---
title: "源码解析 RustFS ECStore 初始化：format.json、远端磁盘 RPC 与 deployment_id 收敛（2026）"
author: F3D
pubDatetime: 2026-07-02T11:34:34+08:00
description: "沿真实 8 节点 16 磁盘 Docker 集群，解释 RustFS ECStore 如何初始化 format.json，并让多 pool 复用同一个 deployment_id。"
tags:
  - release
  - rustfs
  - storage
  - rust
draft: false
---

上一篇已经沿启动路径追到 `EndpointServerPools`：`RUSTFS_VOLUMES` 被展开成 pool、endpoint 和 DistErasure 拓扑。这个拓扑还不是可读写的对象存储。真正把拓扑变成运行时存储层的，是 `ECStore::new()`。

本文只关注 ECStore 初始化里的四个问题：

1. 每个 pool 如何打开本地盘和远端盘；
2. `format.json` 是谁创建、谁写入、谁读取；
3. 多节点同时启动时，非 first 节点为什么不会生成另一个 `format.id`；
4. 多 pool 场景里，后续 pool 的 first 节点为什么会复用第一个 pool 的 `deployment_id`。

实验环境是一个真实运行的 Docker 集群：8 个 RustFS 容器节点，每个节点 2 块盘，一共 16 个 disk endpoint。所有容器里的 `RUSTFS_VOLUMES` 相同：

```text
http://node{1...4}:9000/data{1...2} http://node{5...8}:9000/data{1...2}
```

这条配置会形成两个 pool：

```text
pool 0: node1..node4，每个节点 /data1、/data2
pool 1: node5..node8，每个节点 /data1、/data2
```

本文源码基于 RustFS `main@f6689f5b397a7a41be453ea5b9618f2114584e7e`。实验输出里的 deployment id 只保留前缀，避免把本机运行细节写成公开标识。

![RustFS ECStore initialization writes format.json through local and remote DiskAPI paths, then reuses pool0 fm.id when pool1 initializes](https://img.f3dlife.com/blog/2026/07/02/ecstore-format-init-cbaf51a5-e5d0-4fa6-acee-2a4cd372c00a.png)
Fig. ECStore 初始化不是中心服务下发集群 ID；pool first 节点把 `format.json` 写到对应 pool 的每块盘，其他节点重试读取 quorum。后续 pool 初始化时，`deployment_id` 已经从前一个 pool 的 `fm.id` 得到。

## 目录

- [1 ECStore 初始化入口](#1-ecstore-初始化入口)
- [2 init_disks：把 endpoint 变成 DiskStore](#2-init_disks把-endpoint-变成-diskstore)
- [3 本地盘打开时做了什么](#3-本地盘打开时做了什么)
- [4 format.json 如何被创建和写入](#4-formatjson-如何被创建和写入)
- [5 其他节点如何靠重试收敛](#5-其他节点如何靠重试收敛)
- [6 多 pool：pool1 为什么复用 pool0 的 deployment_id](#6-多-poolpool1-为什么复用-pool0-的-deployment_id)
- [7 datausage 目录是什么](#7-datausage-目录是什么)
- [8 本地盘接口与远端盘 RPC](#8-本地盘接口与远端盘-rpc)
- [9 小结](#9-小结)
- [参考资料](#参考资料)

## 1 ECStore 初始化入口

启动阶段进入 `init_startup_storage_runtime()` 后，会创建 `CancellationToken`，然后调用 `ECStore::new(server_addr, endpoint_pools, ctx)`。

源码锚点：
[`rustfs/src/startup_storage.rs#L128-L167`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/startup_storage.rs#L128-L167)
说明 `EndpointServerPools` 已经准备好，接下来进入 ECStore runtime。

`ECStore::new()` 一开始准备三个关键变量：

```rust
let mut deployment_id = None;
let mut pools = Vec::with_capacity(endpoint_pools.as_ref().len());
let mut disk_map = HashMap::with_capacity(endpoint_pools.as_ref().len());
```

源码锚点：
[`crates/ecstore/src/store/init.rs#L167-L177`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init.rs#L167-L177)
说明 `deployment_id` 初始并不存在，它要从后面的 format 读取或创建路径里得到。

后面最重要的是这个循环：

```rust
for (i, pool_eps) in endpoint_pools.as_ref().iter().enumerate() {
    let pool_first_is_local = pool_first_endpoint_is_local(pool_eps);

    let (disks, errs) = init_format::init_disks(
        &pool_eps.endpoints,
        &DiskOption {
            cleanup: true,
            health_check: true,
        },
    )
    .await;

    let fm = connect_load_init_formats(
        pool_first_is_local,
        &disks,
        pool_eps.set_count,
        pool_eps.drives_per_set,
        deployment_id,
    )
    .await?;

    if deployment_id.is_none() {
        deployment_id = Some(fm.id);
    }

    if deployment_id != Some(fm.id) {
        return Err(Error::other("store init failed: deployment IDs do not match across pools"));
    }

    let sets = Sets::new(disks.clone(), pool_eps, &fm, i, common_parity_drives).await?;
    pools.push(sets);
    disk_map.insert(i, disks);
}
```

这里可以先记住一个顺序：

```text
pool 循环
  -> init_disks()
  -> connect_load_init_formats()
  -> deployment_id = Some(fm.id)
  -> Sets::new()
```

`deployment_id` 是每个进程内的局部变量，但它的值来自磁盘上的 `format.json`。第一次初始化时，它来自 first 节点生成的 `FormatV3::new()`；后续启动时，它来自多数派 format 读取。

## 2 init_disks：把 endpoint 变成 DiskStore

`init_disks()` 本身很短：

```rust
pub async fn init_disks(eps: &Endpoints, opt: &DiskOption)
    -> (Vec<Option<DiskStore>>, Vec<Option<DiskError>>)
{
    let mut futures = Vec::with_capacity(eps.as_ref().len());

    for ep in eps.as_ref().iter() {
        futures.push(new_disk(ep, opt));
    }

    let results = join_all(futures).await;
    ...
}
```

源码锚点：
[`crates/ecstore/src/store/init_format.rs#L34-L59`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init_format.rs#L34-L59)
说明它并发调用 `new_disk()`，并保留每个 endpoint 的成功或失败结果。

输出是两个同长度数组：

```text
disks  = [Some(DiskStore), None, Some(DiskStore), ...]
errors = [None, Some(DiskError), None, ...]
```

保留下标很重要。后面 `format.erasure.sets[i][j]`、endpoint 顺序、set 切分都依赖同一套索引。

`new_disk()` 根据 `ep.is_local` 分流：

```rust
pub async fn new_disk(ep: &Endpoint, opt: &DiskOption) -> Result<DiskStore> {
    if ep.is_local {
        let s = LocalDisk::new(ep, opt.cleanup).await?;
        Ok(Arc::new(Disk::Local(Box::new(
            LocalDiskWrapper::new(Arc::new(s), opt.health_check)
        ))))
    } else {
        let data_transport = build_internode_data_transport_from_env();
        let remote_disk = RemoteDisk::new(ep, opt, data_transport?).await?;
        Ok(Arc::new(Disk::Remote(Box::new(remote_disk))))
    }
}
```

源码锚点：
[`crates/ecstore/src/disk/mod.rs#L486-L495`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/mod.rs#L486-L495)
说明本地 endpoint 会创建 `LocalDiskWrapper(LocalDisk)`，远端 endpoint 会创建 `RemoteDisk`。

在本文环境里，node1 处理 pool0 时看到：

```text
node1:/data1 local
node1:/data2 local
node2:/data1 remote
node2:/data2 remote
node3:/data1 remote
node3:/data2 remote
node4:/data1 remote
node4:/data2 remote
```

同一份 `RUSTFS_VOLUMES`，在不同容器里会得到不同的 local/remote 判断。node2 看 node2 的 `/data1`、`/data2` 是 local，看 node1/node3/node4 是 remote。

## 3 本地盘打开时做了什么

`LocalDisk::new()` 不是简单持有一个文件句柄。它是在构造一个可以执行 `DiskAPI` 的本地磁盘对象。

主要步骤如下。

第一步，解析 endpoint path：

```rust
let endpoint_path = ep.get_file_path();
let root = resolve_local_disk_root(&endpoint_path)?;
```

`resolve_local_disk_root()` 会优先 canonicalize，把路径解析成规范绝对路径；路径不存在会转成 `VolumeNotFound`，不是目录会转成 `DiskNotDir`。

源码锚点：
[`crates/ecstore/src/disk/local.rs#L504-L535`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L504-L535)
说明本地盘必须先解析成可用目录。

第二步，确保 usage 统计目录存在：

```rust
ensure_data_usage_layout(&root).await?;
```

第三步，按需清理启动遗留临时目录：

```rust
if cleanup {
    Self::cleanup_tmp_on_startup(&root, ...).await
}
```

第四步，读取 `.rustfs.sys/format.json`：

```rust
let format_path = root.join(RUSTFS_META_BUCKET).join(super::FORMAT_CONFIG_FILE);
let (format_data, format_meta) = read_file_exists(&format_path).await?;
```

如果 `format.json` 不存在，`read_file_exists()` 不会报致命错误，而是返回空数据：

```rust
if e == Error::FileNotFound {
    (Bytes::new(), None)
}
```

源码锚点：
[`crates/ecstore/src/disk/local.rs#L555-L635`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L555-L635)
说明新盘未格式化时，本地盘对象仍然可以创建成功；是否要初始化 format 是后续 `connect_load_init_formats()` 的判断。

如果 format 存在，`LocalDisk::new()` 会校验 `xl.this` 对应的位置是否和 endpoint 的 `set_idx/disk_idx` 一致：

```rust
let fm = FormatV3::try_from(s)?;
let (set_idx, disk_idx) = fm.find_disk_index_by_disk_id(fm.erasure.this)?;

if set_idx as i32 != ep.set_idx || disk_idx as i32 != ep.disk_idx {
    return Err(DiskError::InconsistentDisk);
}
```

这一步的含义是：盘不只是路径存在，还要证明“我就是拓扑里这个位置的盘”。

## 4 format.json 如何被创建和写入

`connect_load_init_formats()` 是 format 初始化的核心函数：

```rust
let (formats, errs) = load_format_erasure_all(disks, false).await;

if first_disk && should_init_erasure_disks(&errs) {
    let fm = init_format_erasure(disks, set_count, set_drive_count, deployment_id).await?;
    return Ok(fm);
}

let unformatted = quorum_unformatted_disks(&errs);
if unformatted && !first_disk {
    return Err(Error::NotFirstDisk);
}

if unformatted && first_disk {
    return Err(Error::FirstDiskWait);
}

let fm = get_format_erasure_in_quorum(&formats)?;
Ok(fm)
```

源码锚点：
[`crates/ecstore/src/store/init_format.rs#L61-L103`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init_format.rs#L61-L103)
说明只有 first 节点在所有盘都未格式化时会创建 format；非 first 节点会返回 `NotFirstDisk`。

first 节点由 pool 的第一个 endpoint 决定：

```rust
fn pool_first_endpoint_is_local(pool: &PoolEndpoints) -> bool {
    pool.endpoints.as_ref().first().is_some_and(|endpoint| endpoint.is_local)
}
```

源码锚点：
[`crates/ecstore/src/store/init.rs#L29-L31`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init.rs#L29-L31)
说明 first 不是选举出来的，而是由 `RUSTFS_VOLUMES` 的 endpoint 顺序决定。

在本文环境里：

```text
pool0 first endpoint = http://node1:9000/data1
pool1 first endpoint = http://node5:9000/data1
```

全新初始化 pool0 时，node1 是 first 节点。它会调用 `init_format_erasure()`：

```rust
let fm = FormatV3::new(set_count, set_drive_count);
let mut fms = vec![None; disks.len()];

for i in 0..set_count {
    for j in 0..set_drive_count {
        let idx = i * set_drive_count + j;
        let mut newfm = fm.clone();
        newfm.erasure.this = fm.erasure.sets[i][j];
        if let Some(id) = deployment_id {
            newfm.id = id;
        }

        fms[idx] = Some(newfm);
    }
}

save_format_file_all(disks, &fms).await?;
get_format_erasure_in_quorum(&fms)
```

源码锚点：
[`crates/ecstore/src/store/init_format.rs#L129-L153`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init_format.rs#L129-L153)
说明每块盘写入的 format 拥有相同 `id` 和相同 `sets`，但 `erasure.this` 不同。

`FormatV3::new()` 会生成 deployment id：

```rust
Self {
    version: FormatMetaVersion::V1,
    format,
    id: Uuid::new_v4(),
    erasure,
    disk_info: None,
}
```

源码锚点：
[`crates/ecstore/src/layout/format.rs#L149-L163`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/layout/format.rs#L149-L163)
说明第一次初始化时，`fm.id` 来自 `Uuid::new_v4()`。

保存 format 时，RustFS 先写临时文件，再 rename 成正式 `format.json`：

```rust
disk.write_all(RUSTFS_META_BUCKET, tmpfile.as_str(), json_data.into_bytes().into()).await?;

disk.rename_file(RUSTFS_META_BUCKET, tmpfile.as_str(), RUSTFS_META_BUCKET, FORMAT_CONFIG_FILE).await?;

disk.set_disk_id(Some(format.erasure.this)).await?;
```

源码锚点：
[`crates/ecstore/src/store/init_format.rs#L400-L421`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init_format.rs#L400-L421)
说明 format 写入走统一的 `DiskAPI`。

对 node1 本地的 `/data1`、`/data2`，`write_all()` 是本地文件系统写。对 node2 到 node4 的磁盘，`write_all()` 是远端 RPC。也就是说，format id 不是作为单独消息广播给其他节点，而是被写进其他节点磁盘上的 `.rustfs.sys/format.json`。

本文环境里，pool0 的真实 format 结果可以抽象成：

```text
pool0:
  node1 /data1  id = 36daa8f2-...  this = 11d94c60-...
  node2 /data1  id = 36daa8f2-...  this = 67609935-...
  node3 /data1  id = 36daa8f2-...  this = 9c43efd0-...
  node4 /data1  id = 36daa8f2-...  this = 100375a8-...
  node1 /data2  id = 36daa8f2-...  this = a0889059-...
  node2 /data2  id = 36daa8f2-...  this = ac69b3fe-...
  node3 /data2  id = 36daa8f2-...  this = f5bd32de-...
  node4 /data2  id = 36daa8f2-...  this = 11fe1cf8-...
```

`id` 相同，表示同一个 deployment；`this` 不同，表示每块盘自己的身份。

## 5 其他节点如何靠重试收敛

如果 node2 比 node1 更早跑到 pool0 初始化，它也会调用 `connect_load_init_formats()`。但在 node2 看来：

```text
pool0 first endpoint = http://node1:9000/data1
node2 上 first_disk = false
```

如果此时多数盘还未格式化，它会走到：

```rust
let unformatted = quorum_unformatted_disks(&errs);
if unformatted && !first_disk {
    return Err(Error::NotFirstDisk);
}
```

这个错误不会让 node2 自己创建 format。外层 `ECStore::new()` 包了一层重试：

```rust
loop {
    match connect_load_init_formats(...).await {
        Ok(fm) => break Ok(fm),
        Err(e) if times >= 10 => break Err(...),
        Err(_) => {}
    }

    times += 1;
    sleep(Duration::from_secs(interval)).await;

    for disk in disks.iter().flatten() {
        disk.reset_health_for_store_init_retry();
    }
}
```

源码锚点：
[`crates/ecstore/src/store/init.rs#L233-L286`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init.rs#L233-L286)
说明 format 读取/创建失败后会退避重试，并重置临时健康状态。

等 node1 把 pool0 的 `format.json` 写完后，node2 下一次重试会读到 format。读取成功后走：

```rust
let fm = get_format_erasure_in_quorum(&formats)?;
```

`get_format_erasure_in_quorum()` 会从多数派 format 里选出可用的 format，并把 `erasure.this` 清成 nil，返回一个集群视角的 `FormatV3`：

```rust
let mut format = format.as_ref().unwrap().clone();
format.erasure.this = Uuid::nil();
Ok(format)
```

源码锚点：
[`crates/ecstore/src/store/init_format.rs#L209-L240`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init_format.rs#L209-L240)
说明 `fm.id` 是从磁盘 format quorum 读出来的。

因此，非 first 节点的收敛路径是：

```text
read format -> NotFirstDisk / ErasureReadQuorum
  -> sleep retry
  -> first 节点写入 format.json
  -> read quorum
  -> 得到同一个 fm.id
```

## 6 多 pool：pool1 为什么复用 pool0 的 deployment_id

这个问题最容易误判。pool1 的 first 节点确实是 node5，但它不是自由生成一个新的集群 id。

原因在 `ECStore::new()` 的 pool 循环顺序：

```rust
let mut deployment_id = None;

for (i, pool_eps) in endpoint_pools.as_ref().iter().enumerate() {
    let fm = connect_load_init_formats(..., deployment_id).await?;

    if deployment_id.is_none() {
        deployment_id = Some(fm.id);
    }

    if deployment_id != Some(fm.id) {
        return Err(Error::other("store init failed: deployment IDs do not match across pools"));
    }
}
```

源码锚点：
[`crates/ecstore/src/store/init.rs#L293-L299`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init.rs#L293-L299)
说明第一个成功 pool 的 `fm.id` 会成为后续 pool 必须匹配的 `deployment_id`。

本文环境里，每个节点都会先处理 pool0。pool0 成功后：

```text
deployment_id = Some(pool0.fm.id)
```

再处理 pool1 时，`connect_load_init_formats()` 收到的已经不是 `None`，而是 `Some(pool0.fm.id)`。

如果 pool1 也需要初始化 format，node5 作为 pool1 first 节点会进入 `init_format_erasure()`。这个函数内部虽然先创建了一个新的 `FormatV3`，但接着会用传入的 `deployment_id` 覆盖每份 format 的 `id`：

```rust
let mut newfm = fm.clone();
newfm.erasure.this = fm.erasure.sets[i][j];
if let Some(id) = deployment_id {
    newfm.id = id;
}
```

这就是 pool1 复用 pool0 deployment id 的地方。node5 可以为 pool1 生成新的 per-disk `this` UUID，但 `id` 必须沿用 pool0 的 `fm.id`。

本文环境里，pool1 的真实结果可以抽象成：

```text
pool1:
  node5 /data1  id = 36daa8f2-...  this = 8be17bc2-...
  node6 /data1  id = 36daa8f2-...  this = 510b09dd-...
  node7 /data1  id = 36daa8f2-...  this = ece3d3ae-...
  node8 /data1  id = 36daa8f2-...  this = 08dc43be-...
  node5 /data2  id = 36daa8f2-...  this = df53373f-...
  node6 /data2  id = 36daa8f2-...  this = 44fe93c5-...
  node7 /data2  id = 36daa8f2-...  this = 84fb0259-...
  node8 /data2  id = 36daa8f2-...  this = 63c0c95c-...
```

这说明两个 pool 的 disk identity 表不同，但 deployment id 一样。

所以更准确的说法是：

```text
pool first 节点负责本 pool 的 format 初始化；
deployment_id 由第一个成功 pool 的 fm.id 决定；
后续 pool 初始化时只能复用这个 deployment_id。
```

## 7 datausage 目录是什么

`LocalDisk::new()` 里有一行：

```rust
ensure_data_usage_layout(&root).await?;
```

它创建的是每块盘上的 usage 统计目录：

```text
<disk-root>/.rustfs.sys/datausage
<disk-root>/.rustfs.sys/datausage/state
```

源码锚点：
[`crates/ecstore/src/data_usage/local_snapshot.rs#L24-L29`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/data_usage/local_snapshot.rs#L24-L29)
定义目录名；[`crates/ecstore/src/data_usage/local_snapshot.rs#L150-L157`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/data_usage/local_snapshot.rs#L150-L157)
负责创建目录。

这个目录用于保存单盘 usage snapshot。结构里能看到它记录 per-bucket usage、对象总数、版本总数、删除标记数和对象总大小：

```rust
pub struct LocalUsageSnapshot {
    pub buckets_usage: HashMap<String, BucketUsageInfo>,
    pub buckets_count: u64,
    pub objects_total_count: u64,
    pub versions_total_count: u64,
    pub delete_markers_total_count: u64,
    pub objects_total_size: u64,
}
```

源码锚点：
[`crates/ecstore/src/data_usage/local_snapshot.rs#L44-L65`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/data_usage/local_snapshot.rs#L44-L65)
说明 data usage snapshot 不是对象数据，也不是 format identity，而是容量统计缓存。

因此它的作用边界是：

```text
format.json: 证明盘属于哪个 deployment、在 set 中的哪个位置
datausage/: 保存 usage 统计快照和扫描状态
```

两者都在 `.rustfs.sys/` 下，但语义完全不同。

## 8 本地盘接口与远端盘 RPC

上层的 `SetDisks` 不直接关心一块盘是本地还是远端，它看到的是统一的 `DiskAPI`。

源码锚点：
[`crates/ecstore/src/disk/mod.rs#L497-L594`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/mod.rs#L497-L594)
定义 `DiskAPI`，包括 volume、metadata、file、read/write、rename、disk info 等接口。

和本文主题相关的几个接口是：

```rust
async fn write_all(&self, volume: &str, path: &str, data: Bytes) -> Result<()>;
async fn read_all(&self, volume: &str, path: &str) -> Result<Bytes>;
async fn rename_file(&self, src_volume: &str, src_path: &str, dst_volume: &str, dst_path: &str) -> Result<()>;
async fn get_disk_id(&self) -> Result<Option<Uuid>>;
async fn set_disk_id(&self, id: Option<Uuid>) -> Result<()>;
```

本地盘实现直接操作文件系统。`write_all_internal()` 会 open/truncate/write：

```rust
let mut f = self.open_file(file_path, O_CREATE | O_WRONLY | O_TRUNC, skip_parent).await?;
f.write_all(buf).await?;
```

源码锚点：
[`crates/ecstore/src/disk/local.rs#L1523-L1560`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L1523-L1560)
说明本地 `write_all` 最终落到本地文件写入。

远端盘实现把同样的 `DiskAPI` 方法转成 gRPC 请求。proto 里可以看到 `ReadAll`、`WriteAll`、`RenameFile`：

```proto
message WriteAllRequest {
  string disk = 1;
  string volume = 2;
  string path = 3;
  bytes data = 4;
}

message RenameFileRequest {
  string disk = 1;
  string src_volume = 2;
  string src_path = 3;
  string dst_volume = 4;
  string dst_path = 5;
}

rpc ReadAll(ReadAllRequest) returns (ReadAllResponse) {};
rpc WriteAll(WriteAllRequest) returns (WriteAllResponse) {};
rpc RenameFile(RenameFileRequest) returns (RenameFileResponse) {};
```

源码锚点：
[`crates/protos/src/node.proto#L84-L105`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/protos/src/node.proto#L84-L105)
定义 read/write 请求；[`crates/protos/src/node.proto#L172-L182`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/protos/src/node.proto#L172-L182)
定义 rename 请求；[`crates/protos/src/node.proto#L847-L854`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/protos/src/node.proto#L847-L854)
列出相关 RPC。

远端客户端侧，`RemoteDisk::write_all()` 会构造 `WriteAllRequest`：

```rust
let request = Request::new(WriteAllRequest {
    disk,
    volume: volume.to_string(),
    path: path.to_string(),
    data,
});

let response = client.write_all(request).await?;
```

源码锚点：
[`crates/ecstore/src/cluster/rpc/remote_disk.rs#L2094-L2144`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/cluster/rpc/remote_disk.rs#L2094-L2144)
说明远端 `write_all` 是 gRPC 请求，不是共享目录写入。

服务端收到请求后，会先根据 `disk` 找本机本地盘：

```rust
async fn find_disk(&self, disk_path: &str) -> Option<DiskStore> {
    find_local_disk_by_ref(disk_path).await
}
```

然后调用本地 `DiskAPI`：

```rust
if let Some(disk) = self.find_disk(&request.disk).await {
    match disk.write_all(&request.volume, &request.path, request.data).await {
        Ok(_) => ...
        Err(err) => ...
    }
}
```

源码锚点：
[`rustfs/src/storage/rpc/node_service.rs#L200-L202`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/rpc/node_service.rs#L200-L202)
说明 RPC 服务端如何找本机 disk；[`rustfs/src/storage/rpc/disk.rs#L961-L997`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/rpc/disk.rs#L961-L997)
说明 `handle_write_all()` 最终调用本地 `disk.write_all()`。

因此，写 pool0 format 时，node1 对不同盘走的是同一个上层接口：

```text
node1 -> node1:/data1  LocalDisk::write_all
node1 -> node1:/data2  LocalDisk::write_all
node1 -> node2:/data1  RemoteDisk::write_all -> node2 NodeService -> node2 LocalDisk::write_all
node1 -> node3:/data1  RemoteDisk::write_all -> node3 NodeService -> node3 LocalDisk::write_all
...
```

这就是 `format.json` 从 first 节点落到其他机器磁盘上的真实路径。

## 9 小结

ECStore 初始化里最容易混淆的是“集群 ID 的协商”。从源码和本文环境看，它不是一个独立的中心协调协议。

更准确的工作模型是：

```text
1. 所有节点拿到同一份 RUSTFS_VOLUMES。
2. 每个 pool 的第一个 endpoint 决定 first 节点。
3. 全新 pool 只有 first 节点能初始化 format.json。
4. first 节点通过 LocalDisk / RemoteDisk 把 format.json 写到 pool 的所有盘。
5. 非 first 节点遇到多数未格式化时返回 NotFirstDisk，然后重试。
6. 重试成功后，节点从 format quorum 读出 fm.id。
7. ECStore::new 把第一个成功 pool 的 fm.id 保存为 deployment_id。
8. 后续 pool 初始化时，init_format_erasure 会复用这个 deployment_id。
```

因此在本文的 8 节点 16 磁盘环境里：

```text
pool0 first endpoint = node1/data1
pool1 first endpoint = node5/data1

pool0 先确定 deployment id
pool1 复用 pool0 的 deployment id
两个 pool 有不同的 disk this UUID 表
所有盘共享同一个 deployment id
```

这也解释了为什么 `format.json` 既是每块盘自己的身份证，又是整个部署恢复时的共同事实。`this` 指向当前盘，`sets` 描述当前 pool 的 set 布局，`id` 把多个 pool 约束到同一个 deployment。

## 参考资料

- [`crates/ecstore/src/store/init.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init.rs)
- [`crates/ecstore/src/store/init_format.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/init_format.rs)
- [`crates/ecstore/src/disk/mod.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/mod.rs)
- [`crates/ecstore/src/disk/local.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs)
- [`crates/ecstore/src/cluster/rpc/remote_disk.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/cluster/rpc/remote_disk.rs)
- [`crates/ecstore/src/data_usage/local_snapshot.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/data_usage/local_snapshot.rs)
- [`crates/protos/src/node.proto`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/protos/src/node.proto)
- [`rustfs/src/storage/rpc/disk.rs`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/rpc/disk.rs)
