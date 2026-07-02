---
title: "Rust 学习笔记 03：把 Rust 语法看成几种壳"
author: F3D
pubDatetime: 2026-07-02T11:34:02+08:00
description: "从 CommandResult、Arc::new、pub、mod/use/crate、derive、LazyLock、RefCell 和 dyn 入手，把 Rust 初学时最容易混的语法统一到几个模型里。"
tags:
  - release
  - rust
  - c
draft: false
---

## 问题从哪里来

学 Rust 时，很多语法第一眼看起来都像来自不同世界：

```rust
CommandResult::Info(opts)
Arc::new(GlobalReadiness::new())
crate::config::execute_info(&opts)
#[derive(Serialize, Deserialize)]
*GLOBAL_RUSTFS_ADDR.write().await = addr.to_string();
let r = &mut value;
Box<dyn Handler>
```

如果只按符号硬背，很快会乱。`::` 一会儿像模块路径，一会儿像静态方法，一会儿又像 enum 的某个分支；`pub` 看起来像 Java 的 public，但字段、函数、模块又要分开公开；`derive` 更像是编译器突然会帮外部包实现接口。

这篇作为 Rust 学习笔记的第三章，不追求覆盖完整语法，而是整理一个入门时更好用的心智模型：

> 很多 Rust 语法都可以先看成几种“壳”：值的壳、类型的壳、模块的壳、并发容器的壳。

把“壳”和“里面装的东西”分清楚，很多符号就不那么神秘了。

## 1 enum：带标签的壳

先看这段代码：

```rust
let config = match command_result {
    CommandResult::Info(opts) => {
        crate::config::execute_info(&opts);
        return Ok(());
    }
    CommandResult::Tls(opts) => return crate::tls::execute_tls(&opts),
    CommandResult::Server(config) => config,
};
```

最容易卡住的是：

```rust
CommandResult::Info(opts)
```

它看起来像函数调用，但在 `match` 左边，它不是普通函数调用，而是一个**模式**。

可以假设 `CommandResult` 大概长这样：

```rust
enum CommandResult {
    Info(InfoOptions),
    Tls(TlsOptions),
    Server(Config),
}
```

这说明 `command_result` 这个值外面有一层 `CommandResult` 的壳。这个壳上有标签，可能是 `Info`，可能是 `Tls`，也可能是 `Server`。每个标签里面还能装不同的数据。

```text
CommandResult
  Info(opts)
  Tls(opts)
  Server(config)
```

所以：

```rust
CommandResult::Info(opts) => { ... }
```

意思是：

```text
如果这个壳的标签是 Info，就把里面的东西取出来，命名为 opts。
```

同理：

```rust
CommandResult::Server(config) => config
```

意思是：

```text
如果这个壳的标签是 Server，就把里面的 Config 取出来，作为整个 match 的结果。
```

这里有一个很重要的区分：

```rust
let x = CommandResult::Info(opts);
```

这是在**创建**一个 enum 值。

```rust
match x {
    CommandResult::Info(opts) => ...
}
```

这是在**拆开**一个 enum 值。

同一个写法，在表达式位置像构造，在模式位置像拆包。先记住这个差别，就不会把它误认为普通函数调用。

## 2 `::`：路径分隔符，不只用于模块

Rust 里 `::` 很常见：

```rust
std::sync::Arc
Arc::new(...)
CommandResult::Info(...)
crate::config::execute_info(...)
```

它不是单一含义，而是一个路径分隔符。左边是什么，要看上下文。

比如：

```rust
std::sync::Arc::new(...)
```

可以拆成：

```text
std   标准库 crate
sync  std 里的模块
Arc   sync 模块里的类型
new   Arc 类型上的关联函数
```

如果前面写了：

```rust
use std::sync::Arc;
```

后面就可以简写成：

```rust
Arc::new(...)
```

这里的 `Arc` 不是模块，而是一个类型。`new` 是这个类型上的关联函数，比较像 Java 里的静态方法，或者 C++ 里的 `ClassName::function()`。

但 `::` 也可以用于 enum：

```rust
CommandResult::Info(opts)
```

这里的 `CommandResult` 是 enum 类型，`Info` 是它的一个变体。

还可以用于当前 crate 的模块路径：

```rust
crate::config::execute_info(&opts)
```

这里：

```text
crate   当前项目的根
config  根下面的模块
execute_info  模块里的函数
```

所以 `::` 可以先统一理解为：

```text
沿着路径往下找。
```

路径里可能经过 crate、module、type、enum variant、associated function。不要先问“这是不是 namespace”，先看左边那个名字到底是什么。

## 3 `Arc::new`：类型上的关联函数

这一句：

```rust
let readiness = Arc::new(GlobalReadiness::new());
```

可以拆成两步：

```rust
let inner = GlobalReadiness::new();
let readiness = Arc::new(inner);
```

`GlobalReadiness::new()` 是自己定义的类型上的关联函数。常见写法是：

```rust
struct GlobalReadiness {
    ready: bool,
}

impl GlobalReadiness {
    pub fn new() -> Self {
        Self { ready: false }
    }
}
```

`impl GlobalReadiness` 表示给这个类型定义函数。

如果函数参数里没有 `self`、`&self` 或 `&mut self`，它就是关联函数：

```rust
GlobalReadiness::new()
```

如果第一个参数是 `&self` 或 `&mut self`，它就是实例方法：

```rust
impl GlobalReadiness {
    pub fn is_ready(&self) -> bool {
        self.ready
    }
}

let readiness = GlobalReadiness::new();
readiness.is_ready();
```

`Self` 在 `impl GlobalReadiness` 里就等价于 `GlobalReadiness`。所以：

```rust
pub fn new() -> Self {
    Self { ready: false }
}
```

等价于：

```rust
pub fn new() -> GlobalReadiness {
    GlobalReadiness { ready: false }
}
```

Rust 没有固定的构造函数语法，`new` 只是约定俗成的名字。标准库里的 `Arc::new`、`AtomicU8::new`、`RwLock::new` 都是同一类思路：在类型上定义一个创建实例的关联函数。

## 4 `pub`：公开的是某一层，不是整棵树

Rust 默认是私有的。`pub` 是 public，表示对外公开。

但它不是“一开全开”。类型、字段、函数、模块都要分别决定是否公开。

比如：

```rust
pub struct Config {
    address: String,
}

impl Config {
    pub fn new() -> Self {
        Self {
            address: "127.0.0.1".to_string(),
        }
    }
}
```

这里外部可以知道 `Config` 这个类型，也可以调用：

```rust
Config::new()
```

但不能直接访问：

```rust
config.address
```

因为字段 `address` 没有 `pub`。

如果要公开字段，要写：

```rust
pub struct Config {
    pub address: String,
}
```

模块也是一样。假设目录是：

```text
src/
  main.rs
  config.rs
  config/
    tls.rs
```

`main.rs` 里：

```rust
mod config;
```

这表示当前 crate 有一个子模块 `config`，内容在 `config.rs` 或 `config/mod.rs`。

如果 `config.rs` 里有：

```rust
pub mod tls;

pub fn execute_info() {
    println!("info");
}
```

`tls.rs` 里有：

```rust
pub fn execute_tls() {
    println!("tls");
}
```

外面才能调用：

```rust
crate::config::execute_info();
crate::config::tls::execute_tls();
```

这里有三件事要分清：

```text
mod  把模块挂到模块树上
pub  控制能不能被外部访问
use  把路径引入当前作用域，少写前缀
```

`use` 不是定义模块。比如：

```rust
use std::sync;
```

只是把 `sync` 这个模块名引入当前作用域。后面要写：

```rust
sync::Arc::new(value)
```

如果想直接写：

```rust
Arc::new(value)
```

应该引入类型：

```rust
use std::sync::Arc;
```

可以把 `use` 粗略理解为：

```text
把路径最后一段名字放到当前作用域。
```

## 5 外部 crate：先在 Cargo.toml 声明，再在代码里用路径

`crate::config::execute_info()` 里的 `crate` 指当前项目根模块。

外部依赖也叫 crate，但使用方式不一样。通常先在 `Cargo.toml` 里写：

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

然后代码里可以写：

```rust
use serde::{Serialize, Deserialize};
```

或者直接写完整路径：

```rust
serde_json::to_string(&config)
```

如果依赖名里有短横线，代码里通常变成下划线。比如：

```toml
[dependencies]
crossbeam-channel = "0.5"
```

代码里一般是：

```rust
use crossbeam_channel::unbounded;
```

所以判断一个名字是内部模块还是外部依赖，可以看两个地方：

```text
crate::xxx         当前 crate 内部模块
xxx::yyy          可能是外部 crate，也可能是 use 引进来的名字
Cargo.toml 里有   说明它是依赖 crate，可能是第三方，也可能是 workspace/path 依赖
mod xxx;          说明它是当前模块声明出来的子模块
```

比如 `rustfs_common::...` 和 `startup_runtime_sources::...` 如果是这样使用：

```rust
use rustfs_common::Something;
use startup_runtime_sources::SomethingElse;
```

第一反应应该是：它们是 crate 级名字。至于是第三方包，还是同一个 workspace 里的内部 crate，要继续看 `Cargo.toml` 里是版本依赖、git 依赖，还是 `path` 依赖。

## 6 `derive`：编译期帮你生成 impl

这句：

```rust
#[derive(Serialize, Deserialize)]
struct Config {
    address: String,
}
```

可以拆成两部分：

```rust
#[ ... ]
```

这是 attribute，可以理解成给下面这段代码加编译期标记。

```rust
derive(Serialize, Deserialize)
```

表示让编译器帮这个类型自动派生某些 trait 实现。

`Serialize` 和 `Deserialize` 通常来自 `serde`。它们不是“接口自己突然实现了”，而是 serde 提供了编译期宏。宏读取你的 struct 或 enum，然后生成类似这样的代码：

```rust
impl serde::Serialize for Config {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // 把 self.address 按字段名 address 序列化出去
    }
}
```

真实生成的代码会复杂很多，因为它要处理泛型、生命周期、enum、字段重命名、跳过字段、默认值等情况。但核心动作很简单：

```text
输入：struct Config { address: String }
输出：impl Serialize for Config { ... }
```

这和 Java annotation processor 或 Lombok 有点像。不是 trait 自动拥有了你的类型，而是编译期工具帮你写了一段 `impl`。

为什么编译器知道外部包的 `Serialize`？

因为 `Cargo.toml` 里开启了：

```toml
serde = { version = "1", features = ["derive"] }
```

这个 feature 会把 serde 的 derive 宏带进编译过程。然后：

```rust
use serde::{Serialize, Deserialize};
```

让当前作用域能找到这些名字。

还有一个限制：字段本身也必须能序列化。

```rust
#[derive(Serialize)]
struct Config {
    address: String,
}
```

之所以能工作，是因为 `String` 已经实现了 `Serialize`。

如果字段类型没有实现：

```rust
struct SecretThing;

#[derive(Serialize)]
struct Config {
    secret: SecretThing,
}
```

编译器就会报错。宏可以生成外层 `Config` 的实现，但它不能凭空知道 `SecretThing` 应该怎么序列化。

## 7 `debug!`、`{:?}` 和 `%`

Rust 里带 `!` 的通常是宏调用：

```rust
println!("hello");
debug!("something");
vec![1, 2, 3];
```

所以：

```rust
debug!(
    address = %config.address,
);
```

这里的 `debug!` 不是普通函数，而是日志宏。这个写法很像 `tracing` 的结构化日志：

```rust
address = %config.address
```

可以读成：

```text
日志字段名是 address
字段值是 config.address
使用 Display 格式输出
```

`%` 是 `tracing` 宏自己的语法，类似：

```rust
format!("{}", config.address)
```

如果写：

```rust
debug!(address = ?config.address);
```

则类似：

```rust
format!("{:?}", config.address)
```

这里的 `{:?}` 是 Rust 格式化字符串里的 Debug 格式：

```rust
println!("{}", name);   // Display
println!("{:?}", name); // Debug
```

`{}` 偏向给用户看的正常展示，`{:?}` 偏向给开发者看的调试展示。

比如字符串：

```rust
let name = "alice";

println!("{}", name);   // alice
println!("{:?}", name); // "alice"
```

很多类型没有实现 `Display`，但可以通过 `#[derive(Debug)]` 支持 `{:?}`：

```rust
#[derive(Debug)]
struct Config {
    address: String,
}

println!("{:?}", config);
```

所以可以把这组语法记成：

```text
debug!     宏调用
%value     tracing 里用 Display 记录字段
?value     tracing 里用 Debug 记录字段
{}         format Display
{:?}       format Debug
{:#?}      format Debug pretty-print
```

## 8 `LazyLock<RwLock<String>>`：全局壳里再套并发壳

最后看这段全局地址：

```rust
pub static GLOBAL_RUSTFS_ADDR: LazyLock<RwLock<String>> =
    LazyLock::new(|| RwLock::new("".to_string()));

pub async fn set_global_addr(addr: &str) {
    *GLOBAL_RUSTFS_ADDR.write().await = addr.to_string();
}
```

从类型开始拆：

```rust
LazyLock<RwLock<String>>
```

从外到内是：

```text
LazyLock  懒初始化，只在第一次访问时初始化
RwLock    读写锁，允许多个读，写时独占
String    真正保存的地址字符串
```

初始化部分：

```rust
LazyLock::new(|| RwLock::new("".to_string()))
```

这里的：

```rust
|| RwLock::new("".to_string())
```

是一个无参数闭包。它不会在定义 `static` 的时候立刻执行，而是等第一次访问 `GLOBAL_RUSTFS_ADDR` 时才执行，并且只执行一次。

这就是 `LazyLock` 的 lazy：

```text
定义全局变量时，先保存初始化函数。
第一次访问时，执行初始化函数。
之后访问时，复用同一个结果。
```

再看修改函数：

```rust
pub async fn set_global_addr(addr: &str) {
    *GLOBAL_RUSTFS_ADDR.write().await = addr.to_string();
}
```

可以展开成：

```rust
pub async fn set_global_addr(addr: &str) {
    let mut guard = GLOBAL_RUSTFS_ADDR.write().await;
    *guard = addr.to_string();
}
```

如果这里用的是 `tokio::sync::RwLock`，`write()` 是异步的，所以要 `.await`。当写锁暂时拿不到时，Tokio 不会阻塞当前线程，而是挂起当前 async task，把线程让给别的任务。

`guard` 不是 `String` 本身，而是一个写锁 guard。它指向锁里面真正的 `String`。所以：

```rust
*guard = addr.to_string();
```

前面的 `*` 是解引用，意思是修改 guard 指向的内部值。

这里有自动 deref，但赋值左边不能省掉 `*`。

比如：

```rust
guard.push_str("abc");
```

方法调用时，Rust 可以自动把它理解成：

```rust
(*guard).push_str("abc");
```

但如果写：

```rust
guard = addr.to_string();
```

就变成想把一个 `String` 赋值给 `RwLockWriteGuard<String>`，类型完全不对。真正要替换的是 guard 里面的字符串，所以必须写：

```rust
*guard = addr.to_string();
```

## 9 `mut`：变量可变和引用可变不是一回事

Rust 里的 `mut` 很容易被误解，因为它至少出现在两层地方：

```text
let mut x   这个变量绑定可以被改
&mut T      这是一个独占可变引用
```

先看普通变量：

```rust
let s = String::from("hello");
s.push_str(" world"); // 不行
```

`push_str` 需要修改 `s`，也就是需要拿到 `&mut String`。但 `s` 没有声明成 `mut`，所以不能被可变借用。

要写成：

```rust
let mut s = String::from("hello");
s.push_str(" world");
```

这里的 `mut` 控制的是：

```text
s 这个变量绑定里的值能不能被修改。
```

再看另一个容易混的例子：

```rust
let mut s = String::from("hello");

let r = &mut s;
r.push_str(" world");
```

注意：

```rust
let r = &mut s;
```

这里 `r` 本身没有写 `mut`，但依然可以通过 `r` 修改 `s`。原因是 `r` 的类型已经是：

```rust
&mut String
```

它代表的是“我拿到了对这个 `String` 的独占可变访问权”。

那 `let mut r` 又是什么意思？

```rust
let mut s1 = String::from("a");
let mut s2 = String::from("b");

let mut r = &mut s1;
r.push_str("x");

r = &mut s2;
r.push_str("y");
```

这里的 `mut r` 控制的是：

```text
r 这个引用变量本身能不能重新指向别处。
```

所以可以压成两句话：

```text
let mut r  控制 r 这个变量能不能重新赋值
&mut T     控制能不能修改 r 指向的那个 T
```

这也是为什么有时候“没声明 mut 也能改”。很可能不是因为 Rust 放松了规则，而是你改的不是变量绑定本身，而是通过一个可变引用、锁、Cell 或 RefCell 修改了更里面的一层。

## 10 内部可变性：不可变外壳，可控可变内核

普通规则是：

```text
&T      只能共享读取
&mut T  才能独占修改
```

但有些类型可以通过 `&self` 修改内部状态。比如：

```rust
use std::cell::Cell;

let count = Cell::new(0);

count.set(1);
count.set(count.get() + 1);
```

`count` 没有声明成 `mut`，但 `Cell` 里面的值变了。这种能力叫**内部可变性**。

它的核心不是“绕开 Rust”，而是类型自己提供了额外机制，保证修改仍然安全：

```text
Cell<T>      直接替换值，不把内部引用交出来
RefCell<T>   运行时检查借用规则，违反就 panic
Mutex<T>     用锁保证同一时间只有一个线程修改
RwLock<T>    用读写锁保证多个读或一个写
AtomicU8     用 CPU 原子操作保证并发安全
```

底层还有一个更基础的名字：`UnsafeCell<T>`。它是 Rust 里内部可变性的原语。普通 `&T` 会让编译器假设这块内存不会被修改；`UnsafeCell<T>` 则告诉编译器：

```text
这块内存即使通过共享引用，也可能被受控地修改。
```

`Cell`、`RefCell`、`Mutex`、`RwLock` 这类安全类型，都是在这个底层能力外面包了一层规则。

`Cell<T>` 可以粗略想成：

```rust
pub struct Cell<T> {
    value: UnsafeCell<T>,
}
```

它通常不把内部引用交给你，只允许整体读写：

```rust
use std::cell::Cell;

let age = Cell::new(18);
age.set(19);

println!("{}", age.get());
```

对于非 `Copy` 类型，不能随便 `get()`，但可以替换：

```rust
use std::cell::Cell;

let s = Cell::new(String::from("hello"));
let old = s.replace(String::from("world"));

println!("{}", old);
```

`RefCell<T>` 更灵活。它允许借出内部引用，但把借用检查从编译期推迟到运行时。

```rust
use std::cell::RefCell;

let names = RefCell::new(vec!["alice".to_string()]);

names.borrow_mut().push("bob".to_string());

println!("{:?}", names.borrow());
```

可以把 `RefCell` 想成：

```text
value   真正的数据
borrow  当前借用状态
```

借用状态大概是：

```text
0     当前没有借用
> 0   当前有多少个不可变借用
-1    当前有一个可变借用
```

调用 `borrow()` 时，如果当前没有可变借用，就把不可变借用计数加一。调用 `borrow_mut()` 时，只有当前没有任何借用，才允许拿可变借用。

如果违反规则，编译能过，但运行时会 panic：

```rust
use std::cell::RefCell;

let value = RefCell::new(String::from("hello"));

let r1 = value.borrow();
let r2 = value.borrow_mut(); // panic
```

所以 `Cell` 和 `RefCell` 的区别可以这样记：

```text
Cell<T>
  不借内部引用
  直接 get/set/replace 整个值
  适合 bool、数字、enum 状态这类小值

RefCell<T>
  可以 borrow/borrow_mut 内部值
  运行时维护借用状态
  适合 Vec、String、自定义结构体
```

它们一般用于单线程。如果要跨线程共享状态，通常用 `Mutex`、`RwLock` 或 `Atomic`。

## 11 `dyn`：把不同具体类型放进同一个接口壳

`dyn Trait` 表示 trait object，也就是：

```text
具体类型我现在不写死，只要求它实现了某个 trait。
```

比如：

```rust
trait Handler {
    fn handle(&self);
}

struct LoginHandler;
struct LogoutHandler;

impl Handler for LoginHandler {
    fn handle(&self) {
        println!("login");
    }
}

impl Handler for LogoutHandler {
    fn handle(&self) {
        println!("logout");
    }
}
```

如果只写：

```rust
let handlers = vec![LoginHandler, LogoutHandler];
```

是不行的。`Vec<T>` 要求里面每个元素都是同一个具体类型。`LoginHandler` 和 `LogoutHandler` 都实现了 `Handler`，但它们仍然是两个不同类型。

这时可以用：

```rust
let handlers: Vec<Box<dyn Handler>> = vec![
    Box::new(LoginHandler),
    Box::new(LogoutHandler),
];

for handler in handlers {
    handler.handle();
}
```

`Box<dyn Handler>` 就是一个统一的接口壳。里面可以装任何实现了 `Handler` 的具体类型。

常见形式有：

```rust
&dyn Handler
Box<dyn Handler>
Arc<dyn Handler>
```

分别表示：

```text
&dyn Handler    借用一个 trait object
Box<dyn Handler> 拥有一个堆上的 trait object
Arc<dyn Handler> 多个地方共享一个 trait object
```

`dyn` 背后通常可以理解成一个胖指针：

```text
data pointer    指向真实对象，比如 LoginHandler
vtable pointer  指向方法表，记录 handle 应该调哪个实现
```

所以调用：

```rust
handler.handle()
```

时，Rust 会通过 vtable 在运行时找到真正的方法实现。这叫动态分发。

和它相对的是泛型：

```rust
fn run<T: Handler>(handler: T) {
    handler.handle();
}
```

或者：

```rust
fn run(handler: impl Handler) {
    handler.handle();
}
```

泛型是在编译期确定具体类型，通常更容易被内联优化。`dyn Trait` 是运行时分发，适合这些场景：

```text
一个 Vec 里要放多种实现
运行时根据配置选择具体实现
库想隐藏内部具体类型，只暴露 trait 接口
插件、handler 链、middleware、任务列表
```

所以 `dyn` 不是“更高级的泛型”，它解决的是另一类问题：当具体类型不方便在编译期固定时，用一个 trait object 把不同实现统一起来。

## 12 为什么 `static` 不需要 `mut`

这段代码里还有一个容易疑惑的点：

```rust
pub static GLOBAL_RUSTFS_ADDR: LazyLock<RwLock<String>> = ...
```

为什么不是：

```rust
pub static mut GLOBAL_RUSTFS_ADDR: ...
```

因为我们没有修改 `GLOBAL_RUSTFS_ADDR` 这个全局变量本身。

它一直是同一个：

```text
LazyLock<RwLock<String>>
```

变化的是 `RwLock` 里面保护的那个 `String`。

```text
GLOBAL_RUSTFS_ADDR 本身没有被替换
RwLock 本身没有被替换
RwLock 里面的 String 被替换了
```

这叫内部可变性。`RwLock`、`Mutex`、`AtomicU8` 都是这类东西：外层变量可以不是 `mut`，但可以通过它们提供的安全接口修改内部状态。

如果用 `static mut`，访问通常会进入 `unsafe`，因为全局可变状态很容易造成数据竞争。Rust 更推荐这种模式：

```rust
static GLOBAL: LazyLock<RwLock<T>>
static GLOBAL: LazyLock<Mutex<T>>
static GLOBAL: AtomicU8
```

也就是：全局绑定本身稳定，内部状态通过线程安全容器改变。

## 小结

这一章里碰到的语法很多，但可以压成几组模型：

```text
CommandResult::Info(opts)
  enum 壳：看标签，拆里面的数据

Arc::new(...)
  类型壳：调用类型上的关联函数

crate::config::execute_info(...)
  模块壳：从当前 crate 根路径往下找

#[derive(Serialize)]
  编译期壳：宏根据类型结构生成 impl

LazyLock<RwLock<String>>
  并发壳：全局懒初始化，锁里放真正的数据

let r = &mut value
  可变引用：r 不一定可重新赋值，但它能修改指向的 value

Cell / RefCell
  内部可变性壳：外层共享引用不变，内部用规则控制修改

Box<dyn Handler>
  接口壳：不同具体类型统一按同一个 trait 调用

*guard = value
  解引用：修改壳里面指向的值
```

Rust 的符号密度很高。刚开始不熟悉时，最容易把所有 `::`、`pub`、`derive`、`*`、`dyn` 都看成单独的怪语法。更有用的办法是先问三个问题：

```text
这个名字是模块、类型、enum 变体，还是宏？
这个值是外面的壳，还是壳里面的数据？
这行代码是在创建、访问、拆开，还是替换内部值？
```

问清楚这三个问题，大部分初学阶段的 Rust 语法就能落到一个比较稳定的位置上。
