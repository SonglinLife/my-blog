---
title: "源码解析 RustFS PUT Object：从 HTTP 入口到 xl.meta 提交（2026）"
author: F3D
pubDatetime: 2026-07-02T18:37:32+08:00
description: "沿 8 节点 16 磁盘 Docker 集群，梳理 RustFS 的 PUT Object 如何经过 s3s、ECStore、pool/set 选择、纠删码写入和 xl.meta 提交。"
tags:
  - release
  - rustfs
  - storage
  - rust
draft: false
---

上一篇沿启动路径看完 `ECStore` 初始化之后，下一条自然路径是 PUT Object：一个 S3 写请求从 HTTP 入口进入 RustFS，最终怎样落到 ECStore、erasure set、`xl.meta` 和 `part.1`。

本文沿普通 `PUT /<bucket>/<object>` 追一条主线：

1. `FS::put_object` 为什么看不到显式调用点；
2. `execute_put_object()` 如何把 HTTP body 包装成 `PutObjReader`；
3. ECStore 如何在两个 pool 之间选择目标 pool；
4. pool 内如何根据 object key 选择 set；
5. `SetDisks::put_object()` 如何写临时 shard，并通过 `rename_data()` 提交最终 `xl.meta`。

本文源码基于 RustFS `main@f6689f5b397a7a41be453ea5b9618f2114584e7e`。实验拓扑沿用前文的 Docker 集群：8 个 RustFS 容器节点，每个节点 2 块盘，一共 16 个 disk endpoint。

```text
RUSTFS_VOLUMES=
  http://node{1...4}:9000/data{1...2}
  http://node{5...8}:9000/data{1...2}
```

它会形成两个 pool：

```text
pool 0: node1..node4，每个节点 /data1、/data2
pool 1: node5..node8，每个节点 /data1、/data2
```

每个 pool 在这个环境里可以理解为一个 8 盘 erasure set。下文以请求打到 node1 为视角：node1 自己的两块盘是 `Disk::Local`，其他节点上的盘是 `Disk::Remote`。

![RustFS PUT Object request flows from s3s and DefaultObjectUsecase into ECStore pool selection, SetDisks erasure encoding, temporary shard writes, and final xl.meta commit](https://img.f3dlife.com/blog/2026/07/02/put-object-entry-41a70d1f-9fc4-4dbf-9a21-291476d980d7.svg)
Fig. PUT Object 的主线不是一跳写磁盘：HTTP 请求先由 `s3s` 分发到 `FS` 的 trait 实现，再进入 `DefaultObjectUsecase`，最后才交给 ECStore 选择 pool/set 并在 `SetDisks` 内完成临时写入和提交。

## 目录

- [1 HTTP 入口：FS 注册给 s3s](#1-http-入口fs-注册给-s3s)
- [2 execute_put_object：从请求到 PutObjReader](#2-execute_put_object从请求到-putobjreader)
- [3 store 从哪里来：AppContext 和 resolver](#3-store-从哪里来appcontext-和-resolver)
- [4 ECStore 的对象层结构](#4-ecstore-的对象层结构)
- [5 多 pool：已有对象留原 pool，新对象按空间选择](#5-多-pool已有对象留原-pool新对象按空间选择)
- [6 Object 不存在时：普通新写入怎么继续](#6-object-不存在时普通新写入怎么继续)
- [7 查对象是否已存在：并发读取 xl.meta](#7-查对象是否已存在并发读取-xlmeta)
- [8 read quorum：不是读到几个就算几个](#8-read-quorum不是读到几个就算几个)
- [9 set 选择：hash 的是 object key，不含 bucket](#9-set-选择hash-的是-object-key不含-bucket)
- [10 SetDisks::put_object：真正写数据的地方](#10-setdisksput_object真正写数据的地方)
- [11 rename_data：把临时写入提交为最终对象](#11-rename_data把临时写入提交为最终对象)
- [12 小结](#12-小结)
- [参考资料](#参考资料)

## 1 HTTP 入口：FS 注册给 s3s

PUT Object 的 HTTP 入口注册在 `rustfs/src/server/http.rs`。源码里先创建一个 `FS`，再把它交给 `S3ServiceBuilder`：

[`rustfs/src/server/http.rs#L519-L560`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/server/http.rs#L519-L560)

```rust
let s3_service = {
    let store = storage::ecfs::FS::new();
    let mut b = S3ServiceBuilder::new(store.clone());

    b.set_auth(IAMAuth::new(access_key, secret_key));
    b.set_access(store);

    b.build()
};
```

这里有三个动作：

1. `S3ServiceBuilder::new(store.clone())`：把 `FS` 作为 S3 API 的业务实现注册进去；
2. `b.set_auth(...)`：设置认证逻辑；
3. `b.set_access(store)`：把同一个 `FS` 作为访问控制回调注册进去。

因此 `FS` 在这条链路上扮演两个角色：一个是 S3 handler，一个是 S3 access checker。

这也解释了一个源码阅读陷阱：在 RustFS 仓库里搜索 `put_object(`，会看到 `impl S3 for FS` 和 `impl S3Access for FS` 里各有一个 `put_object`，但很难找到普通的 `fs.put_object(...)` 调用点。真实调用点在依赖库 `s3s` 的服务分发里。

`S3Access::put_object` 位于 `rustfs/src/storage/access.rs`：

[`rustfs/src/storage/access.rs#L1881-L1908`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/access.rs#L1881-L1908)

```rust
async fn put_object(&self, req: &mut S3Request<PutObjectInput>) -> S3Result<()> {
    let req_info = ext_req_info_mut(&mut req.extensions)?;
    req_info.bucket = Some(req.input.bucket.clone());
    req_info.object = Some(req.input.key.clone());
    req_info.version_id = req.input.version_id.clone();

    if has_write_offset_bytes_header(&req.headers) {
        return Err(S3Error::with_message(
            S3ErrorCode::NotImplemented,
            ApiError::error_code_to_message(&S3ErrorCode::NotImplemented),
        ));
    }

    authorize_request(req, Action::S3Action(S3Action::PutObjectAction)).await?;

    Ok(())
}
```

这一层不写数据，也不决定对象放到哪个 pool。它先把 bucket/object/version 信息写入 request context，再检查 `PutObjectAction` 等权限。

鉴权之后，`s3s` 会进入 `impl S3 for FS` 的业务方法：

[`rustfs/src/storage/ecfs.rs#L1203-L1207`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/ecfs.rs#L1203-L1207)

```rust
#[instrument(level = "debug", skip(self, req))]
async fn put_object(&self, req: S3Request<PutObjectInput>) -> S3Result<S3Response<PutObjectOutput>> {
    let usecase = s3_api::default_object_usecase();
    Box::pin(usecase.execute_put_object(self, req)).await
}
```

这就是普通 PUT Object 应用层主流程的门口。

## 2 execute_put_object：从请求到 PutObjReader

`execute_put_object()` 位于 `rustfs/src/app/object_usecase.rs`。入口先区分普通 PUT 和 POST Object：

[`rustfs/src/app/object_usecase.rs#L2586-L2592`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L2586-L2592)

```rust
fn put_object_execution_context(req: &S3Request<PutObjectInput>) -> (EventName, QuotaOperation, &'static str) {
    if req.extensions.get::<PostObjectRequestMarker>().is_some() {
        (put_event_name_for_post_object(true), QuotaOperation::PostObject, "POST")
    } else {
        (put_event_name_for_post_object(false), QuotaOperation::PutObject, "PUT")
    }
}
```

普通 `PUT /bucket/object` 会得到：

```text
event_name      = ObjectCreated:Put 相关事件
quota_operation = QuotaOperation::PutObject
request_method  = "PUT"
```

随后函数拆出 `PutObjectInput`，校验 object key、bucket quota、body 和对象大小：

[`rustfs/src/app/object_usecase.rs#L2617-L2676`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L2617-L2676)

```rust
let input = std::mem::take(&mut req.input);

let PutObjectInput {
    body,
    bucket,
    key,
    content_length,
    metadata,
    version_id,
    ..
} = input;

validate_object_key(&key, request_method_name)?;
validate_table_catalog_object_mutation(&bucket, &key).await?;

if let Some(size) = content_length {
    self.check_bucket_quota(&bucket, quota_operation, size as u64).await?;
}

let Some(body) = body else { return Err(s3_error!(IncompleteBody)) };
```

再往后，函数会把 HTTP body 包成 `HashReader`，并把压缩、SSE、checksum、用户 metadata 等信息落到 `ObjectOptions`：

[`rustfs/src/app/object_usecase.rs#L2880-L2958`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L2880-L2958)

```rust
let mut reader = if should_compress {
    // compression path
    HashReader::from_stream(body, size, size, md5hex.take(), sha256hex.take(), false)?
} else {
    // normal / eager path
    HashReader::from_stream(body, size, actual_size, md5hex, sha256hex, false)?
};

reader = write_plan.apply(reader, actual_size).map_err(ApiError::from)?;

let mut reader = PutObjReader::new(reader);
```

最后，应用层把请求交给底层对象存储：

[`rustfs/src/app/object_usecase.rs#L3012-L3016`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L3012-L3016)

```rust
let obj_info = match store
    .put_object(&bucket, &key, &mut reader, &opts)
    .await
    .map_err(ApiError::from)
{
    Ok(obj_info) => { /* ... */ }
    Err(err) => { /* ... */ }
};
```

到这里，请求已经从 S3 框架层进入 ECStore 数据面。

## 3 store 从哪里来：AppContext 和 resolver

上节里出现了一个变量：`store`。它不是 `FS` 本身，而是启动阶段初始化好的 `Arc<ECStore>`。

`execute_put_object()` 在准备 SSE、metadata 和 `ObjectOptions` 之前，会先拿到可用 store，并验证 bucket：

[`rustfs/src/app/object_usecase.rs#L2726-L2726`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L2726-L2726)

```rust
let store = get_validated_store(&bucket).await?;
```

`get_validated_store()` 通过 runtime source 解析当前对象存储句柄：

[`rustfs/src/storage/ecfs_extend.rs#L840-L859`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/ecfs_extend.rs#L840-L859)

```rust
pub(crate) async fn get_validated_store(bucket: &str) -> S3Result<Arc<super::ECStore>> {
    let Some(store) = runtime_sources::current_object_store_handle() else {
        return Err(S3Error::with_message(S3ErrorCode::InternalError, "Not init".to_string()));
    };

    store
        .get_bucket_info(bucket, &BucketOptions::default())
        .await
        .map_err(ApiError::from)?;

    Ok(store)
}
```

这个 handle 来自全局 `AppContext`。启动阶段完成 ECStore、IAM、KMS 初始化后，会调用：

[`rustfs/src/app/context/startup.rs#L33-L43`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/context/startup.rs#L33-L43)

```rust
pub(crate) fn ensure_startup_after_iam(store: Arc<ECStore>, kms_interface: Arc<KmsServiceManager>) -> Result<()> {
    ensure_startup_app_context_after_iam_with(
        || get_global_app_context().is_some(),
        || {
            let iam_interface =
                runtime_sources::ready_iam_handle().map_err(|_| Error::other("IAM is initialized but unavailable"))?;
            init_global_app_context(AppContext::with_default_interfaces(store, iam_interface, kms_interface));
            Ok(())
        },
    )?;
    Ok(())
}
```

`init_global_app_context()` 把 `AppContext` 放进 `OnceLock`，并注册一个 object store resolver：

[`rustfs/src/app/context/global.rs#L327-L335`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/context/global.rs#L327-L335)

```rust
static APP_CONTEXT_SINGLETON: OnceLock<Arc<AppContext>> = OnceLock::new();

pub fn init_global_app_context(context: AppContext) -> Arc<AppContext> {
    let context = APP_CONTEXT_SINGLETON.get_or_init(|| Arc::new(context)).clone();
    let resolver_context = context.clone();
    let _ = set_object_store_resolver(Arc::new(move || Some(resolver_context.object_store())));
    context
}
```

ecstore crate 里的 resolver 则优先调用这个闭包，兜底旧的全局对象层：

[`crates/ecstore/src/runtime/global.rs#L195-L207`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/runtime/global.rs#L195-L207)

```rust
pub fn resolve_object_store_handle() -> Option<Arc<ECStore>> {
    GLOBAL_OBJECT_STORE_RESOLVER
        .get()
        .and_then(|resolver| resolver())
        .or_else(new_object_layer_fn)
}
```

所以这段可以记成：

```text
启动阶段初始化 ECStore
  -> AppContext 持有 Arc<ECStore>
  -> 注册 object_store_resolver
  -> PUT 请求里 get_validated_store(bucket)
  -> 拿到同一个 Arc<ECStore>
```

这解释了 `execute_put_object()` 里 `store.put_object(...)` 的来源。

## 4 ECStore 的对象层结构

前文初始化之后，node1 进程里的对象层结构可以记成：

```text
ECStore
  └── pools: Vec<Arc<Sets>>
        └── disk_set: Vec<Arc<SetDisks>>
              └── disks: Arc<RwLock<Vec<Option<DiskStore>>>>
                    └── DiskStore = Arc<Disk>
                          └── enum Disk {
                                Local(LocalDiskWrapper),
                                Remote(RemoteDisk),
                              }
```

对应概念是：

```text
ECStore = 整个对象层
pool    = 一个 server pool
set     = 一个 erasure set
disk    = set 里的一个盘位
```

`SetDisks` 里保存当前 set 的磁盘列表：

[`crates/ecstore/src/set_disk/mod.rs#L1039-L1043`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1039-L1043)

```rust
pub struct SetDisks {
    pub locker_owner: String,
    pub disks: Arc<RwLock<Vec<Option<DiskStore>>>>,
    pub set_endpoints: Vec<Endpoint>,
    pub set_drive_count: usize,
```

`Disk::Local` 和 `Disk::Remote` 在 ECStore 初始化阶段决定：

[`crates/ecstore/src/disk/mod.rs#L486-L495`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/mod.rs#L486-L495)

```rust
pub async fn new_disk(ep: &Endpoint, opt: &DiskOption) -> Result<DiskStore> {
    if ep.is_local {
        let s = LocalDisk::new(ep, opt.cleanup).await?;
        Ok(Arc::new(Disk::Local(Box::new(LocalDiskWrapper::new(Arc::new(s), opt.health_check)))))
    } else {
        let data_transport = build_internode_data_transport_from_env();
        let remote_disk = RemoteDisk::new(ep, opt, data_transport?).await?;
        Ok(Arc::new(Disk::Remote(Box::new(remote_disk))))
    }
}
```

因此在 node1 看 pool0 时，大致是：

```text
pool0 / set0
  node1/data1 Local
  node1/data2 Local
  node2/data1 Remote
  node2/data2 Remote
  node3/data1 Remote
  node3/data2 Remote
  node4/data1 Remote
  node4/data2 Remote
```

pool1 的 node5-node8 磁盘从 node1 视角基本都是 `Remote`。上层 `SetDisks` 调用 `disk.read_version()`、`disk.rename_data()` 时不关心 local/remote，具体文件系统读写或 RPC 分派由 `Disk` enum 处理。

## 5 多 pool：已有对象留原 pool，新对象按空间选择

ECStore 的 `ObjectIO::put_object()` 会转到 `handle_put_object()`：

[`crates/ecstore/src/store/mod.rs#L333-L355`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/mod.rs#L333-L355)

```rust
async fn put_object(&self, bucket: &str, object: &str, data: &mut PutObjReader, opts: &ObjectOptions) -> Result<ObjectInfo> {
    enqueue_transition_after_write(self.handle_put_object(bucket, object, data, opts).await, LcEventSrc::S3PutObject).await
}
```

`handle_put_object()` 先检查 bucket/object 参数，再把 directory object 编码，然后选择 pool：

[`crates/ecstore/src/store/object.rs#L651-L678`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/object.rs#L651-L678)

```rust
pub(super) async fn handle_put_object(
    &self,
    bucket: &str,
    object: &str,
    data: &mut PutObjReader,
    opts: &ObjectOptions,
) -> Result<ObjectInfo> {
    check_put_object_args(bucket, object)?;

    let object = encode_dir_object(object);

    if self.single_pool() {
        return self.pools[0].put_object(bucket, object.as_str(), data, opts).await;
    }

    let idx = if opts.data_movement && opts.version_id.is_some() {
        self.select_data_movement_pool_idx(bucket, &object, data.size(), opts, false).await?
    } else {
        self.get_pool_idx(bucket, &object, data.size()).await?
    };

    self.pools[idx].put_object(bucket, &object, data, opts).await
}
```

普通 PUT 在两个 pool 环境里走 `get_pool_idx()`。这个函数的策略是：

```text
先查对象已经在哪个 pool
  -> 如果对象存在，继续写原 pool

如果对象不存在
  -> 根据 pool 可用空间选择一个 pool

如果查对象报了非 ObjectNotFound 错误
  -> 返回错误

如果没有任何 pool 可写
  -> DiskFull
```

源码锚点：
[`crates/ecstore/src/store/rebalance.rs#L170-L190`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/rebalance.rs#L170-L190)

对象存在性检查会并发查所有 pool：

[`crates/ecstore/src/store/rebalance.rs#L253-L266`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/rebalance.rs#L253-L266)

```rust
for pool in self.pools.iter() {
    let mut pool_opts = opts.clone();
    if !pool_opts.metadata_chg {
        pool_opts.version_id = None;
    }

    futures.push(async move { pool.get_object_info(bucket, object, &pool_opts).await });
}

let results = join_all(futures).await;
```

如果两个 pool 都没有这个对象，`get_available_pool_idx()` 会按 available 空间加权随机选择：

[`crates/ecstore/src/store/rebalance.rs#L77-L99`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/rebalance.rs#L77-L99)

```rust
let total = server_pools.total_available();
let random_u64: u64 = rng.random_range(0..total);

let choose = random_u64 % total;
let mut at_total = 0;

for pool in server_pools.iter() {
    at_total += pool.available;
    if at_total > choose && pool.available > 0 {
        return Some(pool.index);
    }
}
```

例如：

```text
pool0 available = 700 GiB
pool1 available = 300 GiB
total = 1000 GiB
```

新对象大约 70% 选 pool0，30% 选 pool1。覆盖写已有对象则优先留在原 pool，不会因为另一个 pool 当前更空就迁移过去。

## 6 Object 不存在时：普通新写入怎么继续

Object 不存在不是 PUT 的错误路径。对普通新对象写入来说，它只是让 RustFS 从“沿用已有 pool”切换到“选择一个可写 pool”。

应用层会先检查当前对象是否存在，主要目的是处理覆盖写、Object Lock 和容量统计：

[`rustfs/src/app/object_usecase.rs#L2819-L2831`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L2819-L2831)

```rust
let previous_current_size = match store.get_object_info(&bucket, &key, &current_opts).await {
    Ok(existing_obj_info) => {
        validate_existing_object_lock_for_write(&existing_obj_info, &opts)?;
        Some(existing_obj_info.size.max(0) as u64)
    }
    Err(err) => {
        if !is_err_object_not_found(&err) && !is_err_version_not_found(&err) {
            return Err(ApiError::from(err).into());
        }
        None
    }
};
```

这里有三种结果：

```text
找到对象
  -> 校验已有对象锁
  -> previous_current_size = Some(size)

ObjectNotFound / VersionNotFound
  -> 不是错误
  -> previous_current_size = None
  -> 继续普通新写入

其他错误
  -> 返回 S3 错误
```

进入 ECStore 后，`get_pool_idx()` 也会先查对象在哪个 pool。如果所有 pool 都返回 ObjectNotFound，它才调用 `get_available_pool_idx()`：

[`crates/ecstore/src/store/rebalance.rs#L170-L190`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/rebalance.rs#L170-L190)

```rust
let idx = match self
    .get_pool_idx_existing_with_opts(bucket, object, &ObjectOptions {
        skip_decommissioned: true,
        skip_rebalancing: true,
        ..Default::default()
    })
    .await
{
    Ok(res) => res,
    Err(err) => {
        if !is_err_object_not_found(&err) {
            return Err(err);
        }

        if let Some(hit_idx) = self.get_available_pool_idx(bucket, object, size).await {
            hit_idx
        } else {
            return Err(Error::DiskFull);
        }
    }
};
```

所以新对象的 pool 分支是：

```text
pool0.get_object_info(...) -> ObjectNotFound
pool1.get_object_info(...) -> ObjectNotFound
  -> get_available_pool_idx(bucket, object, size)
  -> 按可用空间选 pool
  -> self.pools[idx].put_object(...)
```

选中 pool 后，后面不再需要旧对象的 `FileInfo`。`SetDisks::put_object()` 会创建一份全新的 `FileInfo`：

[`crates/ecstore/src/set_disk/mod.rs#L1899-L1915`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1899-L1915)

```rust
let mut fi = FileInfo::new([bucket, object].join("/").as_str(), data_drives, parity_drives);

if opts.versioned && fi.version_id.is_none() {
    fi.version_id = Some(Uuid::new_v4());
}

fi.data_dir = Some(Uuid::new_v4());

let parts_metadata = vec![fi.clone(); disks.len()];
```

对一个没有开启 versioning 的普通新对象：

```text
version_id = None
data_dir   = 新 UUID
parts_metadata = 每个 disk 一份新 FileInfo
```

随后写入路径和覆盖写共用同一套机制：

```text
创建 .rustfs.sys/tmp/<tmp_dir>/<data_dir>/part.1
  -> bitrot writer 写临时 shard
  -> Erasure::encode* 生成 data/parity shard
  -> 填充每块盘的 FileInfo
  -> rename_data() 提交为 <bucket>/<object>/xl.meta
```

差别在提交阶段。新对象通常没有旧 `xl.meta` 和旧 `data_dir`；本地 `rename_data()` 读取目标 `xl.meta` 时会把 `FileNotFound` 当成“目标为空”，然后创建新的 `FileMeta`，加入本次 `FileInfo`：

[`crates/ecstore/src/disk/local.rs#L3076-L3117`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L3076-L3117)

```rust
let has_dst_buf = match super::fs::read_file(&dst_file_path).await {
    Ok(res) => Some(res),
    Err(e) => {
        let e: DiskError = to_file_error(e).into();
        if e != DiskError::FileNotFound {
            return Err(e);
        }
        None
    }
};

let mut xlmeta = FileMeta::new();
if let Some(dst_buf) = has_dst_buf.as_ref()
    && FileMeta::is_xl2_v1_format(dst_buf)
    && let Ok(nmeta) = FileMeta::load(dst_buf)
{
    xlmeta = nmeta
}

xlmeta.add_version(fi)?;
let new_dst_buf = xlmeta.marshal_msg()?;
```

这就是 Object 不存在时的完整含义：**不存在只影响 pool 选择和目标 metadata 是否为空；真正的写入、纠删码分片、write quorum、`rename_data()` 提交流程仍然是同一条路径。**

## 7 查对象是否已存在：并发读取 xl.meta

对象是否已存在，最终要看各个 pool 对应 set 上的 `xl.meta`。

`Sets::get_object_info()` 会根据 object key 选 set，然后进入 `SetDisks::get_object_info()`：

[`crates/ecstore/src/core/sets.rs#L494-L496`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/core/sets.rs#L494-L496)

```rust
async fn get_object_info(&self, bucket: &str, object: &str, opts: &ObjectOptions) -> Result<ObjectInfo> {
    self.get_disks_by_key(object).get_object_info(bucket, object, opts).await
}
```

`SetDisks::get_object_info()` 会拿对象读锁，再调用 `get_object_fileinfo()`：

[`crates/ecstore/src/set_disk/mod.rs#L3483-L3496`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L3483-L3496)

```rust
async fn get_object_info(&self, bucket: &str, object: &str, opts: &ObjectOptions) -> Result<ObjectInfo> {
    let _read_lock_guard = if !opts.no_lock {
        Some(self.acquire_read_lock_diag("get_object_info", bucket, object).await?)
    } else {
        None
    };

    let (fi, _, _) = self
        .get_object_fileinfo(bucket, object, opts, true)
        .await
        .map_err(|e| to_object_err(e, vec![bucket, object]))?;
```

`get_object_fileinfo()` 先尝试 metadata cache；如果没命中，就拿当前 set 的 `disks` 并发读取每块盘上的 metadata：

[`crates/ecstore/src/set_disk/read.rs#L1731-L1761`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/read.rs#L1731-L1761)

```rust
let disks = self.disks.read().await;
let disks = disks.clone();

let (parts_metadata, errs, metadata_fanout_diagnostics) = Self::read_all_fileinfo_observed(
    &disks,
    "",
    bucket,
    object,
    vid.as_str(),
    read_data,
    false,
    opts.incl_free_versions,
    self.default_parity_count,
)
.await?;
```

从 node1 查询 `rebalance-demo/before-expand/obj-076.bin` 时，可以把它理解成：

```text
pool0.get_object_info("rebalance-demo", "before-expand/obj-076.bin")
  -> pool0 的某个 SetDisks
  -> 并发读取 8 个盘位上的:
     rebalance-demo/before-expand/obj-076.bin/xl.meta

pool1.get_object_info("rebalance-demo", "before-expand/obj-076.bin")
  -> pool1 的某个 SetDisks
  -> 并发读取另一组 8 个盘位上的:
     rebalance-demo/before-expand/obj-076.bin/xl.meta
```

本地盘直接读文件，远端盘走 internode RPC。`Disk::read_version()` 的分派在：

[`crates/ecstore/src/disk/mod.rs#L234-L244`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/mod.rs#L234-L244)

```rust
async fn read_version(...) -> Result<FileInfo> {
    match self {
        Disk::Local(local_disk) => local_disk.read_version(_org_volume, volume, path, version_id, opts).await,
        Disk::Remote(remote_disk) => remote_disk.read_version(_org_volume, volume, path, version_id, opts).await,
    }
}
```

远端盘的 `RemoteDisk::read_version()` 会构造 `ReadVersionRequest` 发给远端节点：

[`crates/ecstore/src/cluster/rpc/remote_disk.rs#L1411-L1440`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/cluster/rpc/remote_disk.rs#L1411-L1440)

这就是“查对象是否已存在”的实际 I/O：它不是只看某个内存索引，而是从候选 pool/set 的磁盘元数据里恢复对象视图。

## 8 read quorum：不是读到几个就算几个

读取多个磁盘的 `xl.meta` 后，RustFS 还要判断这些元数据是否达到 quorum，并从多份 `FileInfo` 中选出一份有效版本。

`get_object_fileinfo()` 的关键段是：

[`crates/ecstore/src/set_disk/read.rs#L1771-L1788`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/read.rs#L1771-L1788)

```rust
let (read_quorum, _) = match Self::object_quorum_from_meta(&parts_metadata, &errs, self.default_parity_count)
    .map_err(|err| to_object_err(err.into(), vec![bucket, object]))
{
    Ok(v) => v,
    Err(e) => {
        return Err(e);
    }
};

let read_quorum =
    usize::try_from(read_quorum).map_err(|_| to_object_err(DiskError::ErasureReadQuorum.into(), vec![bucket, object]))?;

if let Some(err) = reduce_read_quorum_errs(&errs, OBJECT_OP_IGNORED_ERRS, read_quorum) {
    return Err(to_object_err(err.into(), vec![bucket, object]));
}

let (op_online_disks, mot_time, etag) = Self::list_online_disks(&disks, &parts_metadata, &errs, read_quorum);

let fi = Self::pick_valid_fileinfo(&parts_metadata, mot_time, etag, read_quorum)?;
```

这段可以拆成四步：

```text
1. 根据多个 FileInfo 推导 read_quorum
2. 看错误数量是否已经破坏 read_quorum
3. 找出达到 quorum 的共同 mod_time 或 etag
4. 从候选 FileInfo 中选出内容身份一致的一份
```

`object_quorum_from_meta()` 会先从有效 `FileInfo` 中找共同 parity：

[`crates/ecstore/src/metadata/set_disk.rs#L256-L295`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/metadata/set_disk.rs#L256-L295)

```rust
let parities = Self::list_object_parities(parts_metadata, errs);
let parity_blocks = Self::common_parity(&parities, default_parity_count as i32);

let data_blocks = parts_metadata.len() as i32 - parity_blocks;
let write_quorum = if data_blocks == parity_blocks {
    data_blocks + 1
} else {
    data_blocks
};

Ok((data_blocks, write_quorum))
```

对本文的 8 盘 set，假设 parity=4：

```text
total shards  = 8
parity_blocks = 4
data_blocks   = 8 - 4 = 4
read_quorum   = 4
write_quorum  = 5  // data == parity 时，写 quorum 要 data + 1
```

但 read quorum 不只是“成功读到 4 份”。`pick_valid_fileinfo()` 最终会进入 `find_file_info_in_quorum()`，对关键 `FileInfo` 内容计算 hash：

[`crates/ecstore/src/metadata/set_disk.rs#L341-L479`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/metadata/set_disk.rs#L341-L479)

参与 hash 的内容包括 size、deleted 标记、version_id、data_dir、checksum、part 信息，以及 erasure data/parity/distribution。**最终要达到 quorum 的，是内容身份一致的 `FileInfo`。**

例如：

```text
disk0: FileInfo A, parity=4, mod_time=T1, hash=H1
disk1: FileInfo A, parity=4, mod_time=T1, hash=H1
disk2: FileInfo A, parity=4, mod_time=T1, hash=H1
disk3: FileInfo A, parity=4, mod_time=T1, hash=H1
disk4: FileInfo old, parity=4, mod_time=T0, hash=H0
disk5: FileNotFound
disk6: DiskNotFound
disk7: FileInfo A, parity=4, mod_time=T1, hash=H1
```

`H1` 有 5 票，超过 read quorum=4，因此返回 `FileInfo A`。

如果是：

```text
disk0: hash=H1
disk1: hash=H1
disk2: hash=H2
disk3: hash=H2
disk4: error
disk5: error
disk6: error
disk7: error
```

虽然成功读到了 4 个，但没有任何内容身份达到 4 票，最终会返回 `ErasureReadQuorum`。

## 9 set 选择：hash 的是 object key，不含 bucket

pool 选定之后，`Sets::put_object()` 会在 pool 内选择 set：

[`crates/ecstore/src/core/sets.rs#L416-L418`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/core/sets.rs#L416-L418)

```rust
async fn put_object(&self, bucket: &str, object: &str, data: &mut PutObjReader, opts: &ObjectOptions) -> Result<ObjectInfo> {
    self.get_disks_by_key(object).put_object(bucket, object, data, opts).await
}
```

`get_disks_by_key()` 只接收 key：

[`crates/ecstore/src/core/sets.rs#L278-L280`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/core/sets.rs#L278-L280)

```rust
pub fn get_disks_by_key(&self, key: &str) -> Arc<SetDisks> {
    self.get_disks(self.get_hashed_set_index(key))
}
```

这里要区分 S3 的两个概念：

```text
bucket = "photos"
object key / object name = "2026/a.jpg"
完整定位 = bucket + object key
```

同一个 object key 可以跨 bucket 重复：

```text
bucket-a/report.pdf
bucket-b/report.pdf
```

在 RustFS 这条路径里，set 选择 hash 的是 object key，不含 bucket。也就是说，`bucket-a/foo.txt` 和 `bucket-b/foo.txt` 在同一个 pool 内会映射到同一个 set，但最终磁盘路径不同：

```text
<disk>/bucket-a/foo.txt/xl.meta
<disk>/bucket-b/foo.txt/xl.meta
```

所以它们不会冲突。

## 10 SetDisks::put_object：真正写数据的地方

真正写对象从 `SetDisks::put_object()` 开始：

[`crates/ecstore/src/set_disk/mod.rs#L1852-L1876`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1852-L1876)

```rust
async fn put_object(&self, bucket: &str, object: &str, data: &mut PutObjReader, opts: &ObjectOptions) -> Result<ObjectInfo> {
    self.invalidate_get_object_metadata_cache(bucket, object).await;

    let disks = self.get_disks_internal().await;

    let mut object_lock_guard = None;

    if opts.http_preconditions.is_some() {
        if !opts.no_lock {
            object_lock_guard = Some(
                self.acquire_write_lock_diag("put_object_precondition", bucket, object)
                    .await?,
            );
        }

        if let Some(err) = self.check_write_precondition(bucket, object, opts).await {
            return Err(err);
        }
    }
```

如果有 `If-Match`、`If-None-Match` 之类条件写，RustFS 会先拿对象写锁并检查旧元数据。没有条件写时，大块数据写入阶段不会长期持有对象写锁，写锁主要覆盖后面的 commit。

接下来计算 data/parity/write quorum：

[`crates/ecstore/src/set_disk/mod.rs#L1878-L1895`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1878-L1895)

```rust
let sc_parity_drives = runtime_sources::storage_class_parity(user_defined.get(AMZ_STORAGE_CLASS).map(String::as_str));

let mut parity_drives = sc_parity_drives.unwrap_or(self.default_parity_count);
if opts.max_parity {
    parity_drives = disks.len() / 2;
}

let data_drives = disks.len() - parity_drives;
let mut write_quorum = data_drives;
if data_drives == parity_drives {
    write_quorum += 1
}
```

本文 8 盘、4+4 情况下：

```text
data_drives  = 4
parity_drives = 4
write_quorum = 5
```

然后创建本次写入的 `FileInfo`：

[`crates/ecstore/src/set_disk/mod.rs#L1899-L1915`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1899-L1915)

```rust
let mut fi = FileInfo::new([bucket, object].join("/").as_str(), data_drives, parity_drives);

if opts.versioned && fi.version_id.is_none() {
    fi.version_id = Some(Uuid::new_v4());
}

fi.data_dir = Some(Uuid::new_v4());

let parts_metadata = vec![fi.clone(); disks.len()];
```

`data_dir` 是本次对象数据目录 UUID。非 inline 对象的数据会先写到临时目录下，最后再提交到最终对象路径。

写入前还会按照 erasure distribution 重排磁盘和 metadata：

[`crates/ecstore/src/metadata/set_disk.rs#L574-L599`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/metadata/set_disk.rs#L574-L599)

```rust
let block_idx = distribution[k];
shuffled_parts_metadata[block_idx - 1] = parts_metadata[k].clone();
shuffled_disks[block_idx - 1].clone_from(&disks[k]);
```

这样磁盘顺序和 erasure shard index 对齐。

临时对象路径在这里生成：

[`crates/ecstore/src/set_disk/mod.rs#L1919-L1921`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1919-L1921)

```rust
let tmp_dir = Uuid::new_v4().to_string();

let tmp_object = format!("{}/{}/part.1", tmp_dir, fi.data_dir.unwrap());
```

对应磁盘上的逻辑位置是：

```text
.rustfs.sys/tmp/<tmp_dir>/<data_dir>/part.1
```

然后为每个 disk 创建 bitrot writer：

[`crates/ecstore/src/set_disk/mod.rs#L1924-L1964`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1924-L1964)

```rust
match create_bitrot_writer(
    is_inline_buffer,
    Some(disk),
    RUSTFS_META_TMP_BUCKET,
    &tmp_obj,
    shard_file_size,
    shard_size,
    HashAlgorithm::HighwayHash256S,
)
.await
```

如果可用 writer 数量小于 write quorum，直接失败：

[`crates/ecstore/src/set_disk/mod.rs#L1981-L1995`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1981-L1995)

```rust
let nil_count = errors.iter().filter(|&e| e.is_none()).count();
if nil_count < write_quorum {
    if let Some(write_err) = reduce_write_quorum_errs(&errors, OBJECT_OP_IGNORED_ERRS, write_quorum) {
        return Err(to_object_err(write_err.into(), vec![bucket, object]));
    }

    return Err(Error::other(format!("not enough disks to write: {errors:?}")));
}
```

真正把用户 body 编码成 shard 的位置在这里：

[`crates/ecstore/src/set_disk/mod.rs#L2002-L2036`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L2002-L2036)

```rust
let write_path = classify_put_write_path(is_inline_buffer, data.size(), fi.erasure.block_size);

let (reader, w_size) = match write_path {
    SmallWritePath::Inline => {
        Arc::new(erasure).encode_inline_small(stream, &mut writers, write_quorum).await?
    }
    SmallWritePath::SingleBlockNonInline => {
        Arc::new(erasure).encode_single_block_non_inline(stream, &mut writers, write_quorum).await?
    }
    SmallWritePath::PipelineBatchedLarge => {
        Arc::new(erasure).encode_batched(stream, &mut writers, write_quorum).await?
    }
    SmallWritePath::Pipeline => {
        Arc::new(erasure).encode(stream, &mut writers, write_quorum).await?
    }
};
```

心智模型是：

```text
用户 body stream
  -> HashReader
  -> Erasure encoder
  -> data shards + parity shards
  -> 每个 shard 通过 bitrot writer 写入对应 disk 的临时路径
```

写完 shard 之后，RustFS 会填充每块盘要写入 `xl.meta` 的 `FileInfo`：

[`crates/ecstore/src/set_disk/mod.rs#L2087-L2126`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L2087-L2126)

```rust
user_defined.insert("etag".to_owned(), etag.clone());

for (i, pfi) in parts_metadatas.iter_mut().enumerate() {
    pfi.metadata = user_defined.clone();
    if is_inline_buffer {
        if let Some(writer) = writers[i].take() {
            pfi.data = Some(writer.into_inline_data().map(Bytes::from).unwrap_or_default());
        }

        pfi.set_inline_data();
    }

    pfi.mod_time = mod_time;
    pfi.size = w_size as i64;
    pfi.versioned = opts.versioned || opts.version_suspended;
    pfi.add_object_part(1, etag.clone(), w_size, mod_time, actual_size, index_op.clone(), None);
    pfi.checksum = fi.checksum.clone();
}
```

到这里，临时数据已经写出，最终 metadata 也准备好了，但对象还没有提交到最终路径。

## 11 rename_data：把临时写入提交为最终对象

提交阶段开始前，如果还没有写锁，`SetDisks::put_object()` 会拿对象写锁：

[`crates/ecstore/src/set_disk/mod.rs#L2147-L2160`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L2147-L2160)

```rust
if !opts.no_lock && object_lock_guard.is_none() {
    object_lock_guard = Some(self.acquire_write_lock_diag("put_object_commit", bucket, object).await?);
}

let (online_disks, _, op_old_dir, cleanup_disks) = Self::rename_data(
    &shuffle_disks,
    RUSTFS_META_TMP_BUCKET,
    tmp_dir.as_str(),
    &parts_metadatas,
    bucket,
    object,
    write_quorum,
)
.await?;
```

注意这个锁覆盖的是 commit 阶段。前面的 body 编码和 shard 临时写入没有长时间持有对象写锁。

`rename_data()` 对每块盘并发调用 `disk.rename_data(...)`：

[`crates/ecstore/src/set_disk/write.rs#L33-L72`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/write.rs#L33-L72)

```rust
for (i, (disk, file_info)) in disks.iter().zip(file_infos.iter()).enumerate() {
    let mut file_info = file_info.clone();
    let disk = disk.clone();

    futures.push(tokio::spawn(async move {
        if file_info.erasure.index == 0 {
            file_info.erasure.index = i + 1;
        }

        if !file_info.is_valid() {
            return Err(DiskError::FileCorrupt);
        }

        if let Some(disk) = disk {
            disk.rename_data(&src_bucket, &src_object, file_info, &dst_bucket, &dst_object).await
        } else {
            Err(DiskError::DiskNotFound)
        }
    }));
}
```

如果成功数不足 write quorum，RustFS 会对已经成功的盘执行 `delete_version(... undo_write: true ...)` 做回滚：

[`crates/ecstore/src/set_disk/write.rs#L123-L151`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/write.rs#L123-L151)

成功达到 write quorum 后，`rename_data()` 返回成功磁盘、旧 data_dir 等信息。随后 `SetDisks::put_object()` 会清理旧 data_dir，并释放对象写锁：

[`crates/ecstore/src/set_disk/mod.rs#L2180-L2188`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L2180-L2188)

```rust
if let Some(old_dir) = op_old_dir {
    self.commit_rename_data_dir(&cleanup_disks, bucket, object, &old_dir.to_string(), write_quorum)
        .await?;
}

drop(object_lock_guard);
```

最后清理临时目录：

[`crates/ecstore/src/set_disk/mod.rs#L2315-L2325`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L2315-L2325)

```rust
if let Err(err) = self.delete_all(RUSTFS_META_TMP_BUCKET, &tmp_dir).await {
    warn!(tmp_dir = %tmp_dir, error = ?err, "failed to cleanup put_object temporary data");
}

result
```

本地磁盘的 `rename_data()` 更能看出“提交”的语义：

[`crates/ecstore/src/disk/local.rs#L3006-L3149`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L3006-L3149)

它会构造：

```text
src xl.meta:
  .rustfs.sys/tmp/<tmp_dir>/xl.meta

dst xl.meta:
  <bucket>/<object>/xl.meta
```

并在非 inline 对象路径里：

1. 读取目标对象已有 `xl.meta`；
2. 解析已有版本；
3. 加入本次新版本 `FileInfo`；
4. marshal 成新的 `xl.meta`；
5. rename 临时数据目录到最终对象目录；
6. rename 临时 `xl.meta` 到最终 `<bucket>/<object>/xl.meta`。

核心代码片段：

[`crates/ecstore/src/disk/local.rs#L3095-L3149`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L3095-L3149)

```rust
let version_id = fi.version_id.unwrap_or_default();
let has_old_data_dir = xlmeta.find_unshared_data_dir_for_version(Some(version_id));
if let Some(old_data_dir) = has_old_data_dir.as_ref() {
    let _ = xlmeta.data.remove_two(version_id, *old_data_dir);
}
xlmeta.add_version(fi)?;
let new_dst_buf = xlmeta.marshal_msg()?;

self.write_all_private(
    src_volume,
    &format!("{}/{}", &src_path, STORAGE_FORMAT_FILE),
    new_dst_buf.into(),
    true,
    src_file_parent,
)
.await?;

if let Some((src_data_path, dst_data_path)) = has_data_dir_path.as_ref()
    && let Err(err) = rename_all(src_data_path, dst_data_path, &skip_parent).await
{
    return Err(err);
}

if let Err(err) = rename_all(&src_file_path, &dst_file_path, &skip_parent).await {
    return Err(err);
}
```

所以 commit 的本质是：

```text
临时 shard 数据目录
  -> <bucket>/<object>/<data_dir>

临时 xl.meta
  -> <bucket>/<object>/xl.meta
```

达到 write quorum 后，本次 PUT 返回 `ObjectInfo`。

## 12 小结

PUT Object 的完整路径可以压缩成：

```text
HTTP PUT /bucket/object
  -> s3s::S3Service
  -> FS as S3Access::put_object(&mut req)
  -> FS as S3::put_object(req)
  -> DefaultObjectUsecase::execute_put_object(...)
  -> store.put_object(bucket, key, PutObjReader, ObjectOptions)
  -> ECStore::handle_put_object
  -> get_pool_idx()
  -> Sets::put_object
  -> get_disks_by_key(object key)
  -> SetDisks::put_object
  -> create_bitrot_writer()
  -> Erasure::encode*
  -> rename_data()
  -> <bucket>/<object>/xl.meta
```

本文最重要的几个判断是：

1. `FS::put_object` 的直接分发者是 `s3s`，不是 RustFS 仓库里某个显式 `fs.put_object(...)` 调用；
2. `execute_put_object()` 负责把 S3 请求变成带 checksum、metadata、SSE 等语义的 `PutObjReader` 和 `ObjectOptions`；
3. 多 pool 下，已有对象优先留在原 pool，新对象才按可用空间加权选择；
4. Object 不存在时，应用层和 pool 查询都把 ObjectNotFound 当作普通新写入分支；
5. set 选择 hash 的是 object key，不含 bucket；
6. `SetDisks::put_object()` 先写临时 shard，再在 commit 阶段拿对象写锁并 `rename_data()`；
7. `xl.meta` 的一致性不是只看读到几份，而是看关键 `FileInfo` 内容身份是否达到 read quorum。

从这条线继续往下，下一篇适合专门展开 `create_bitrot_writer()` 和 `Erasure::encode*()`：一个 body 到底如何被切成 data/parity shards，本地盘和远端盘分别怎样写出 `part.1`。

## 参考资料

- [`rustfs/src/server/http.rs#L519-L560`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/server/http.rs#L519-L560)
- [`rustfs/src/storage/access.rs#L1881-L1908`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/access.rs#L1881-L1908)
- [`rustfs/src/storage/ecfs.rs#L1203-L1207`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/ecfs.rs#L1203-L1207)
- [`rustfs/src/app/object_usecase.rs#L2586-L3016`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/object_usecase.rs#L2586-L3016)
- [`rustfs/src/storage/ecfs_extend.rs#L840-L859`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/storage/ecfs_extend.rs#L840-L859)
- [`rustfs/src/app/context/startup.rs#L33-L43`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/context/startup.rs#L33-L43)
- [`rustfs/src/app/context/global.rs#L327-L335`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/rustfs/src/app/context/global.rs#L327-L335)
- [`crates/ecstore/src/runtime/global.rs#L195-L207`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/runtime/global.rs#L195-L207)
- [`crates/ecstore/src/store/object.rs#L651-L678`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/object.rs#L651-L678)
- [`crates/ecstore/src/store/rebalance.rs#L77-L190`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/store/rebalance.rs#L77-L190)
- [`crates/ecstore/src/core/sets.rs#L416-L418`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/core/sets.rs#L416-L418)
- [`crates/ecstore/src/set_disk/mod.rs#L1852-L2325`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/mod.rs#L1852-L2325)
- [`crates/ecstore/src/set_disk/write.rs#L33-L180`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/set_disk/write.rs#L33-L180)
- [`crates/ecstore/src/disk/local.rs#L3006-L3149`](https://github.com/SonglinLife/rustfs/blob/f6689f5b397a7a41be453ea5b9618f2114584e7e/crates/ecstore/src/disk/local.rs#L3006-L3149)
