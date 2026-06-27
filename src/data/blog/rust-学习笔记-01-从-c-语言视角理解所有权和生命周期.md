---
title: "Rust 学习笔记 01：从 C 语言视角理解生命周期和所有权"
author: F3D
pubDatetime: 2026-06-27T17:48:17+08:00
description: "把 Rust 的所有权、借用和生命周期放回栈、堆、指针、malloc/free 这些 C 语言问题里，建立第一层内存安全直觉。"
tags:
  - release
  - rust
  - c
draft: false
---

## 问题从哪里来

我开始学 Rust 时，最先卡住的不是语法，而是几个词：所有权、借用、生命周期。

如果直接从 Rust 的术语进入，很容易觉得它在发明一套新世界观。但如果从 C 语言的视角看，Rust 做的事情其实很朴素：

它想在没有 GC、没有手写 `free` 的前提下，让编译器提前证明一件事：

> 这段程序里的指针不会悬空，不会重复释放，也不会在共享时被偷偷修改。

所以这篇作为 Rust 学习笔记的第一章，我先不追求覆盖所有细节，只尝试建立一个底层直觉：所有权负责“谁释放资源”，借用负责“谁能临时访问资源”，生命周期负责“这个访问会不会比资源活得更久”。

## 先翻译成 C 语言问题

在 C 里，我们很熟悉这几类问题：

```c
char *p = malloc(100);
free(p);
printf("%s", p); // use-after-free
```

或者：

```c
char *p = malloc(100);
char *q = p;
free(p);
free(q); // double free
```

再或者：

```c
int *f() {
    int x = 42;
    return &x; // 返回栈变量地址
}
```

这些问题在 C 语言的内存模型里都很好解释：栈帧会消失，堆内存需要释放，指针只是地址，地址本身不会告诉你背后的对象还活不活。

Rust 的所有权和生命周期，就是把这些本来靠人脑、规范和 code review 才能发现的问题，尽量提前交给编译器。

## 所有权：谁负责释放

先看一个 Rust 里的 `String`：

```rust
let s = String::from("hello");
```

可以粗略把它想成 C 里的一个结构体：

```c
struct String {
    uint8_t *ptr;
    size_t len;
    size_t cap;
};
```

`s` 这个结构体本身在栈上，真正的字符串内容在堆上。问题来了：谁负责释放这块堆内存？

Rust 的答案是：每个值都有且只有一个 owner。owner 离开作用域时，自动调用 `Drop` 释放资源。

```rust
{
    let s = String::from("hello");
} // s 离开作用域，堆内存被释放
```

所以 Rust 不需要手写 `free`。但为了避免 double free，它也不允许两个变量同时拥有同一份堆资源。

```rust
let s1 = String::from("hello");
let s2 = s1;

println!("{}", s1); // 编译错误
```

这里 `s1` 的所有权被 move 给了 `s2`。从底层看，`String` 的 `ptr / len / cap` 这几个字段可能只是被复制到了新的栈位置；但在 Rust 的语义里，旧变量 `s1` 已经失效。

这个规则很像在编译期禁止下面这种 C 风格风险：

```c
String s1 = make_string("hello");
String s2 = s1;

drop(s1);
drop(s2); // 如果两个 String 都认为自己拥有 ptr，就可能 double free
```

对于 `i32`、`bool` 这类简单值，复制没有资源释放问题，所以 Rust 允许它们实现 `Copy`：

```rust
let a = 1;
let b = a;

println!("{}", a); // 可以
```

但对于 `String`、`Vec<T>`、`Box<T>` 这种拥有堆资源的类型，Rust 默认选择 move，而不是隐式深拷贝。

如果确实想复制堆上的内容，要显式写：

```rust
let s1 = String::from("hello");
let s2 = s1.clone();

println!("{}, {}", s1, s2);
```

这也是 Rust 很重要的审美：昂贵的复制应该在代码里看得见。

我用一个最小脚本验证了一下这个区别：`clone` 后两个 `String` 都还能用，而且它们的堆指针不同；普通整数则因为实现了 `Copy`，赋值后旧变量仍然有效。

![Rust 所有权验证：clone 后两个 String 拥有不同堆地址，i32 赋值后仍可继续使用](https://img.f3dlife.com/blog/2026/06/27/ownership-clone-c5a0809a-f9ce-4189-959e-adaa4e5831db.png)

## 借用：不拿走所有权，也能访问

如果每次传参都 move，代码会很别扭：

```rust
fn print_len(s: String) {
    println!("{}", s.len());
}

let s = String::from("hello");
print_len(s);

println!("{}", s); // 编译错误，s 已经被 move
```

很多时候，函数只是想读一下，并不想接管释放责任。这时应该借用：

```rust
fn print_len(s: &String) {
    println!("{}", s.len());
}

let s = String::from("hello");
print_len(&s);

println!("{}", s); // 还可以继续用
```

`&String` 可以理解成一个受编译器检查的只读指针。它不拥有资源，所以不会释放资源；它只是临时看一眼。

更常见的写法会用 `&str`：

```rust
fn print_len(s: &str) {
    println!("{}", s.len());
}
```

这可以同时接收 `String` 的切片和字符串字面量，接口更灵活。

如果要修改调用者的数据，就用可变借用：

```rust
fn add_suffix(s: &mut String) {
    s.push_str(" world");
}

let mut s = String::from("hello");
add_suffix(&mut s);
```

这里的 `&mut` 不只是“可修改指针”。更准确地说，它是“独占引用”：在这段访问期间，不能再有别的引用同时观察或修改同一个值。

Rust 的借用规则可以压成一句话：

> 要么多个只读引用，要么一个可变引用。

也就是：

```text
多个 &T       可以
一个 &mut T   可以
&mut T 和其他引用同时存在  不可以
```

### 从 C 语言视角看：为什么不能同时有可变引用和其他引用

这个限制一开始看着很烦。先不用 `&v[0]`，直接拿 `v` 本身构造冲突。假设 Rust 允许这样写：

```rust
let mut v = Vec::with_capacity(1);
v.push(10);

let view = &v; // 不可变引用：我后面还要观察这个 Vec

v.push(20);  // 可变操作：我要修改这个 Vec

println!("{view:?}");
```

`v.push(20)` 不是给 `v` 重新赋值，而是方法调用。它大致等价于：

```rust
Vec::push(&mut v, 20);
```

所以冲突其实非常直接：

```text
view = &v              的承诺：在 view 还会被使用之前，v 只能被共享读取。
Vec::push(&mut v, 20)  的要求：我需要独占访问 v，才能修改它的内部状态。
```

**如果允许这段代码，同一个 `v` 就会同时处在“被共享观察”和“被独占修改”两种状态。**

这已经足够解释为什么 Rust 要拦住它。接下来再问深一层：为什么 `push` 一定要拿到整个 `Vec` 的独占可变访问？

因为 `Vec<T>` 可以粗略想成 C 里的动态数组：

```c
struct Vec {
    int *ptr;
    size_t len;
    size_t cap;
};
```

`push` 不只是把一个元素写到末尾。容量不够时，它可以申请更大的 buffer，把旧元素搬过去，再释放旧 buffer。也就是说，它有权修改 `v.ptr / v.len / v.cap`。

这也是为什么 `&v[0]` 那种例子更危险。`&v[0]` 虽然借的是第 0 个元素，但这个元素住在 `v` 管理的堆 buffer 里。它的有效性依赖于：

```text
v.ptr 指向的 buffer 还在
第 0 个元素还在那个 buffer 的对应位置
```

编译器为什么知道 `&v[0]` 和 `v` 有关系？

因为 `v[0]` 不是凭空来的。索引操作本质上会从 `v` 借出一个元素引用，可以粗略理解成：

```rust
let first = Index::index(&v, 0);
```

也就是先有一个对 `v` 的共享借用，再从这个借用里得到 `&T`。所以编译器知道：

```text
first 这个引用是从 v 派生出来的
```

而 `v.push(20)` 又大致等价于：

```rust
Vec::push(&mut v, 20);
```

一个从 `v` 派生出来的共享引用后面还要用，同时又想拿 `&mut v`，这就是冲突。

如果 `first` 后面已经不用了，Rust 会把借用生命周期缩短，这段是可以的：

```rust
let first = &v[0];
println!("{first}");

v.push(20);
```

但如果 `first` 要跨过 `push` 继续使用，就不行：

```rust
let first = &v[0];
v.push(20);

println!("{first}");
```

所以这两层其实是同一个问题：

```text
&v      和 push(&mut v)   冲突在：整个 Vec 正被共享观察，却要被独占修改。
&v[0]   和 push(&mut v)   冲突在：有人指着 Vec 的内部 buffer，push 却可能重排这块 buffer。
```

**第一个例子讲规则本身，第二个例子讲这个规则为什么和内存安全有关。**

这就是 C 里很熟悉的 `realloc` 问题：旧地址可能还握在某个指针里，但它已经不再代表一个有效对象了。

所以问题可以写得更尖锐一点：

```text
如果允许 first 继续存在：

first 可能还指着旧 buffer
v.push(20) 可能已经让 v 指向新 buffer

那 println!("{first}") 到底应该读哪里？
```

这不是 Rust 的语法洁癖，而是一个 C 语言式的内存问题：**旧指针还在，新对象已经搬走。**

可能会问：那为什么不能让新旧 buffer 一起存在？`first` 继续读旧 buffer，`v` 继续用新 buffer，不就好了？

这个想法其实是在把 `&v[0]` 当成“快照”。但 Rust 的引用不是快照，`Vec<T>` 也不是持久化数据结构。

`first = &v[0]` 的意思是：

> **我借用了当前这个 `Vec` 里的第 0 个元素。**

它不是：

> **请帮我保存一份旧版本的第 0 个元素。**

如果 `v.push(20)` 以后新旧 buffer 都存在，那么 `first` 读到的是旧版本，`v[0]` 却在新 buffer 里。这样 `first` 就不再是“对 `v[0]` 的引用”，而变成了某种隐藏快照句柄。这个语义已经不是普通引用了。

更麻烦的是所有权。`Vec<T>` 里的元素不一定能随便复制。比如 `Vec<String>` 里的 `String` 自己还拥有一块堆内存。如果扩容时想让旧 buffer 和新 buffer 都保留同一批元素，就会遇到两个选择：

1. 直接把字节复制一份：两个 `String` 会指向同一块字符串内存，最后可能 double free。
2. 真正 clone 每个元素：这要求 `T: Clone`，而且会把一次 `push` 变成可能很贵的深拷贝。

但 `Vec<T>` 必须支持任意 `T`，`push` 也不应该偷偷把整个旧版本保存下来。所以它的合理语义是：**扩容时把元素搬到新 buffer，旧 buffer 不再是这个 `Vec` 的有效存储。**

为了让这个冲突可见，我写了一个 raw pointer 版本。注意它和安全引用版本的对应关系：

```text
let first = &v[0]   -> 安全引用，Rust 会检查它不能悬空
old_raw_ptr         -> 裸地址，Rust 不替它做借用检查
v.push(20)          -> 同一个 Vec 上的可变操作，可能触发 realloc
```

**下面的 raw pointer 例子不是在讲另一个问题。它是在模拟：如果 Rust 允许不可变引用跨过可变操作继续存在，底层可能发生什么。**

为了让演示稳定，我还用了一个小的全局 allocator：当 `Vec` 调用 `realloc` 时，它总是申请一块新内存、拷贝旧内容、释放旧内存，而不是原地扩容。真实系统 allocator 有时可能原地扩容，有时可能搬家；Rust 的安全规则不能依赖“这次刚好没有搬家”。

```rust
use std::alloc::{GlobalAlloc, Layout, System};
use std::ptr;
use std::sync::atomic::{AtomicUsize, Ordering};

struct MovingAllocator;

static REALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for MovingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        REALLOC_CALLS.fetch_add(1, Ordering::SeqCst);

        if new_size == 0 {
            System.dealloc(ptr, layout);
            return ptr::null_mut();
        }

        let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
        let new_ptr = System.alloc(new_layout);

        if !new_ptr.is_null() {
            ptr::copy_nonoverlapping(ptr, new_ptr, layout.size().min(new_size));
            System.dealloc(ptr, layout);
        }

        new_ptr
    }
}

#[global_allocator]
static ALLOCATOR: MovingAllocator = MovingAllocator;

fn main() {
    let mut v = Vec::with_capacity(1);
    v.push(10);

    let old_raw_ptr = v.as_ptr();

    println!(
        "before push: ptr = {old_raw_ptr:p}, len = {}, cap = {}",
        v.len(),
        v.capacity()
    );

    let reallocs_before = REALLOC_CALLS.load(Ordering::SeqCst);
    v.push(20);
    let reallocs_after = REALLOC_CALLS.load(Ordering::SeqCst);

    println!(
        "after  push: ptr = {:p}, len = {}, cap = {}",
        v.as_ptr(),
        v.len(),
        v.capacity()
    );
    println!(
        "realloc calls during push: {}",
        reallocs_after - reallocs_before
    );
    println!("raw pointer still stores old address: {old_raw_ptr:p}");
    println!("old and new addresses differ: {}", old_raw_ptr != v.as_ptr());
}
```

![Rust raw pointer 验证：动态数组换到新 buffer 后，旧 raw pointer 仍保存老地址](https://img.f3dlife.com/blog/2026/06/27/raw-pointer-buffer-replace-629e7d38-6cfe-4961-9501-31137c36df8f.png)

看这张图时，最重要的是这两行：

```text
after  push: ptr = 0x..., len = 2, cap = 4
raw pointer still stores old address: 0x...
```

**`v.push(20)` 之后，`v` 已经指向新 buffer，但旧地址还留在 `old_raw_ptr` 里。**

把 `old_raw_ptr` 换回安全引用的语境，它对应的就是 `first = &v[0]`。所以 Rust 禁止的不是抽象规则本身，而是这个具体冲突：

> **一边还有引用指向旧 buffer，一边又允许可变操作把 `Vec` 搬到新 buffer。**

为什么这会导致问题？

因为“地址还在变量里”和“地址仍然指向一个有效对象”是两回事。旧 buffer 被 `Vec` 放弃以后，那块堆内存就重新回到 allocator 的管理范围。接下来可能发生几种情况：

1. 那块内存暂时还没被复用，读旧地址似乎还能读到原来的值，于是 bug 被隐藏。
2. 那块内存已经被别的对象复用，读旧地址读到的是别人的数据。
3. 如果通过旧地址写入，就可能把别的对象、allocator 元数据，或者程序认为仍然一致的数据结构写坏。

这就是 use-after-free 最讨厌的地方：它不一定立刻崩溃，也不一定每次复现。它取决于堆分配器当时怎么复用内存、程序后面申请了什么对象、优化器做了什么假设。

所以如果 `first = &v[0]` 这样的不可变引用可以在 `v.push(...)` 这个可变操作之后继续存在，Rust 就必须面对一个无法静态保证的问题：**`first` 指向的那块地址，到底还是不是 `v` 的第一个元素？**

Rust 的答案是：不让这个问题进入运行时。

这就是 Rust 要求 `&mut T` 独占的原因。

如果一个 `&T` 还活着，编译器就要保证它指向的东西在这段时间内不会被另一个入口改坏、搬走或释放。如果同时允许一个 `&mut T` 存在，那么这个可变入口理论上可以做任何合法修改：扩容 `Vec`、清空 `String`、替换结构体字段、触发 `Drop`，或者让内部资源换一块地址。

所以 Rust 干脆把语义定死：

> `&mut T` 不是“我有一个可写指针”，而是“我在这段时间里独占这个对象”。

这个独占承诺同时服务两件事：

1. 内存安全：旧引用不会在对象被改写、搬迁或释放后继续使用。
2. 优化假设：编译器可以相信 `&mut T` 没有别名，不需要担心另一个引用偷偷读写同一块内存。

如果确实需要“共享 + 可变”，Rust 也不是完全不允许，而是要求换一种显式工具：单线程可以用 `RefCell<T>` 把借用检查推到运行时，多线程可以用 `Mutex<T>`、`RwLock<T>` 或原子类型把同步边界说清楚。

也就是说，Rust 真正禁止的是：在普通引用层面裸奔的共享可变状态。

回到安全引用版本，Rust 实际会在编译期拦下它：

```rust
let mut v = Vec::with_capacity(1);
v.push(10);

let view = &v;
v.push(20);

println!("view = {view:?}");
```

编译器报的是 `E0502`：`v` 已经被不可变借用了，不能再被可变借用；并且它会指出 `view` 后面还在 `println!` 里使用。

**这条错误不是在限制写法，而是在阻止刚才那个冲突进入运行时：有人还要共享观察 `v`，同时 `push` 又要独占修改 `v`。**

![Rust 借用规则验证：整个 Vec 的不可变引用仍在使用时，push 所需的可变借用会被编译器拒绝](https://img.f3dlife.com/blog/2026/06/27/borrow-vec-error-a422db2a-6b88-44dc-bbd6-5fae7ee41b10.png)

## 生命周期：引用不能比对象活得更久

生命周期听起来像运行时机制，但它不是。

生命周期不是引用计数，不是 GC，也不是对象头里的一段元数据。它主要是编译器用来检查引用有效性的静态信息。

最经典的例子：

```rust
let r;

{
    let x = 42;
    r = &x;
}

println!("{}", r);
```

这段代码不能通过编译。原因很直接：`x` 是内部作用域里的栈变量，出了作用域就不存在了。`r` 如果还能继续用，就等价于拿着一个已经失效的栈地址。

用 C 来写，就是：

```c
int *r;

{
    int x = 42;
    r = &x;
}

printf("%d\n", *r); // 栈变量已经失效
```

Rust 的生命周期检查，就是为了在编译期阻止这种事情。

这段代码也可以直接编译验证。`rustc` 报 `E0597`，核心信息是：`x` 活得不够久，已经在内部作用域结束时被 drop，但 `r` 后面还要继续用它。

![Rust 生命周期验证：引用内部作用域变量会被 E0597 拦住，因为变量先于引用失效](https://img.f3dlife.com/blog/2026/06/27/lifetime-stack-error-e65240ec-57c7-4ec1-9746-be79c9a5d9e2.png)

大多数时候，生命周期不需要手写：

```rust
fn len(s: &str) -> usize {
    s.len()
}
```

编译器能看出来：返回的是一个普通整数，不依赖 `s` 的存活时间。

但如果函数返回引用，事情就复杂一点：

```rust
fn first_word(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or("")
}
```

这里返回的 `&str` 来自输入 `s`，所以它不能比 `s` 活得更久。这个关系编译器通常也能推断。

当一个返回引用可能来自多个输入时，我们就需要显式写生命周期参数：

```rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() {
        x
    } else {
        y
    }
}
```

`'a` 不是在“让 x 和 y 活得一样久”，也不是在延长任何对象的生命。

它表达的是一个约束：

> 返回值的有效期，不能超过 `x` 和 `y` 中较短的那一个。

为什么这里不能自动推断？

因为生命周期标注不是给函数体运行用的，而是函数签名的一部分。它要告诉调用者：**返回的引用到底依赖哪个输入。**

如果只写成这样：

```rust
fn longest(x: &str, y: &str) -> &str
```

返回值和输入之间的关系是不完整的。它可能想表达返回值来自 `x`：

```rust
fn return_x<'a, 'b>(x: &'a str, y: &'b str) -> &'a str {
    x
}
```

也可能想表达返回值来自 `y`：

```rust
fn return_y<'a, 'b>(x: &'a str, y: &'b str) -> &'b str {
    y
}
```

而 `longest` 的特殊之处在于：它可能返回 `x`，也可能返回 `y`。所以它必须在签名里说清楚：

```text
返回引用必须同时受 x 和 y 约束
```

也就是：

```rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str
```

这个写法不是要求 `x` 和 `y` 原本活得一样久。调用时，Rust 会把 `'a` 理解成两者都能覆盖的那段时间，也就是较短的那段。

比如：

```rust
let s1 = String::from("long string");

{
    let s2 = String::from("short");
    let r = longest(&s1, &s2);
    println!("{r}");
}
```

这里 `s1` 活得更久，`s2` 活得更短。`r` 的有效范围不能超过 `s2` 所在的内部作用域。

生命周期标注的作用，是把“返回引用和输入引用之间的关系”告诉编译器。它不改变运行时行为，也不会让一个已经释放的对象重新变得可用。

## 我现在的理解

如果从 C 语言的角度压缩一下，Rust 的这套规则可以这样对应：

```text
malloc/free 的释放责任        -> 所有权与 Drop
结构体里保存堆指针            -> String / Vec / Box 等拥有型类型
普通指针只保存地址            -> Rust 引用还带静态借用检查
返回栈变量地址                -> 生命周期检查拦住
两个指针都以为自己负责 free    -> move 后旧绑定失效
realloc 后继续使用旧地址       -> 借用规则拦住
共享状态同时被修改            -> &mut 必须独占
```

这也是我觉得 Rust 最值得先建立的心智模型：

Rust 不是不让我们碰内存。恰恰相反，它非常接近底层内存模型。但它要求我们把“谁拥有资源、谁只是借用、借用能活多久”说清楚。

这些信息在 C 里通常藏在程序员脑子里，在 Rust 里会变成类型系统和编译器检查的一部分。

## 小结

这一章先只记三句话：

1. 所有权解决的是：谁负责释放资源。
2. 借用解决的是：不拿走所有权时，如何安全访问资源。
3. 生命周期解决的是：引用不能比它指向的对象活得更久。

如果已经写过一些 C 语言，学习 Rust 时不必把这些概念当成玄学。可以先把它们都还原成更熟悉的问题：栈帧、堆分配、指针别名、`malloc/free`、`realloc`、use-after-free 和 double free。

Rust 的难点在于，它把这些底层问题提前暴露在编译期。刚开始会有点不顺手，但这也是它真正有价值的地方。

下一篇我想继续沿着这条线，看看 `Box<T>`、`Deref` 和智能指针到底在抽象什么。
