---
title: "Rust 学习笔记 02：用链表理解 Box、Option 和智能指针"
author: F3D
pubDatetime: 2026-06-27T20:54:34+08:00
description: "从一个最直觉但无法编译的链表节点开始，用 Rust 实现 push、pop 和 peek，理解 Box、Option、take、借用和 Drop。"
tags:
  - release
  - rust
  - c
draft: false
---

## 先写一个最直觉的节点

如果按 C 的习惯写单向链表，第一反应大概是：一个节点里保存一个值，再保存一个指向下一个节点的东西。

换到 Rust，最想写的版本可能是这样：

```rust
struct Node<T> {
    elem: T,
    next: Node<T>,
}
```

但这段代码不会通过编译。

我把这个最小版本放在 `examples/rust-learning-02/recursive_node_error.rs` 里，用 `rustc` 编译，错误是 `E0072`：递归类型有无限大小。

![Rust 链表节点验证：Node 直接包含 Node 会触发 E0072，编译器提示用 Box、Rc 或引用切断递归](https://img.f3dlife.com/blog/2026/06/27/recursive-node-error-0f791e3d-f081-4ae7-8bcf-ff2d2d57b38a.png)

**问题不是链表，而是 `Node<T>` 的大小无法在编译期确定。**

具体说，Rust 必须在编译期知道每个类型占多大内存。可是这里的 `Node<T>` 里面又包含一个完整的 `Node<T>`：

```text
Node<T>
  elem: T
  next: Node<T>
          elem: T
          next: Node<T>
                  elem: T
                  next: ...
```

这个类型的大小会无限展开。编译器没法给它分配一个确定的大小。

C 里不会这么写。C 里的链表节点通常长这样：

```c
struct Node {
    int elem;
    struct Node *next;
};
```

关键区别在 `next`：它不是另一个完整节点，而是一个指针。指针的大小是固定的。无论后面还有多少节点，当前节点里只放一个地址。

Rust 里也需要同样的表达：当前节点不直接包含下一个节点，而是拥有一个指向堆上节点的指针。

这就是 `Box<T>` 出场的地方。

## 用 Box 切断无限递归

先把 `next` 改成 `Box<Node<T>>`：

```rust
struct Node<T> {
    elem: T,
    next: Box<Node<T>>,
}
```

`Box<T>` 可以先粗略理解成：

```text
一个拥有 T 的堆指针
```

它和 C 里的裸指针相似，里面都保存一个地址；但它比裸指针多了一个很重要的语义：`Box<T>` 拥有它指向的那个 `T`。当 `Box<T>` 离开作用域时，Rust 会自动释放堆上的对象。

所以 `Box<Node<T>>` 的大小是固定的，因为当前节点里只需要保存一个指针。至于下一个 `Node<T>` 本体，放在堆上。

现在递归结构被切断了：

```text
Node<T>
  elem: T
  next: Box<Node<T>>  // 固定大小的指针
```

这里可能会有一个疑问：编译器刚才的提示里，不只提到了 `Box`，还提到了 `Rc` 和 `&`。那为什么这里不用引用？

比如这样也能让类型大小变成固定的：

```rust
struct Node<'a, T> {
    elem: T,
    next: Option<&'a Node<'a, T>>,
}
```

问题是，`&Node<T>` 只表示“我借用一个节点”，不表示“我拥有这个节点”。但我们现在要实现的是一个拥有型链表：`push_front` 创建一个新节点后，这个节点应该归链表所有，并且在链表释放时一起释放。

如果用引用来写 `push_front`，很快会撞上生命周期问题：

```rust
fn push_front(&mut self, elem: T) {
    let new_node = Node {
        elem,
        next: self.head,
    };

    self.head = Some(&new_node);
}
```

`new_node` 是函数里的局部变量。函数结束时它就会被 drop，而 `self.head` 却想保存它的引用。这个引用一旦留下来，就会变成悬空引用。

这个例子在 `examples/rust-learning-02/reference_list_error.rs`，编译器会报 `E0597`：`new_node` 活得不够久。

![Rust 引用链表验证：用引用保存 push_front 里的局部节点会触发 E0597，因为 new_node 在函数结束时被释放](https://img.f3dlife.com/blog/2026/06/27/reference-list-error-f523c37d-9347-48fa-a16e-104cc65280ba.png)

**引用能切断递归，但不能让链表拥有节点。**

所以这里选择 `Box<Node<T>>`，不是因为引用不能切断递归，而是因为引用不拥有节点。

```text
&Node<T>        -> 借用别人拥有的节点
Box<Node<T>>   -> 拥有堆上的节点
```

链表需要把节点串起来，并负责整条链的释放。这个语义更接近 `Box`，不是普通引用。至于 `Rc<T>`，它表达的是多个 owner 共享同一个节点，适合另一类结构；这篇先不把主线岔过去。

但这还不是一个完整链表。因为链表总要结束。最后一个节点的 `next` 应该指向“没有下一个节点”。

C 里通常用 `NULL`。Rust 里不用空指针表示这种普通业务状态，而是用 `Option`。

## 用 Option 表达链表结尾

最终的节点结构可以写成：

```rust
type Link<T> = Option<Box<Node<T>>>;

struct Node<T> {
    elem: T,
    next: Link<T>,
}
```

`Link<T>` 的意思是：

```text
None                  -> 没有下一个节点
Some(Box<Node<T>>)    -> 有下一个节点，并且拥有它
```

这样，一条链表的所有权关系就很清楚了：

```text
List
  head: Some(Box<Node<T>>)
              elem
              next: Some(Box<Node<T>>)
                          elem
                          next: None
```

`List` 拥有头节点，头节点拥有下一个节点，下一个节点再拥有下一个节点。整条链表不是一堆彼此不知道谁负责释放的地址，而是一条所有权链。

我们先把完整结构写出来：

```rust
pub struct List<T> {
    head: Link<T>,
}

type Link<T> = Option<Box<Node<T>>>;

struct Node<T> {
    elem: T,
    next: Link<T>,
}

impl<T> List<T> {
    pub fn new() -> Self {
        List { head: None }
    }
}
```

这时还没有任何操作，只是定义了一个空链表。

接下来写第一个真正会碰到所有权的问题：往链表头部插入一个元素。

## push_front：把旧 head 接到新节点后面

头插法在逻辑上很简单：

```text
旧链表：
head -> A -> B -> None

插入 X：
head -> X -> A -> B -> None
```

新节点 `X` 的 `next` 应该指向原来的 `head`。然后链表的 `head` 再指向 `X`。

最想写的 Rust 版本可能是这样：

```rust
pub fn push_front(&mut self, elem: T) {
    let new_node = Box::new(Node {
        elem,
        next: self.head,
    });

    self.head = Some(new_node);
}
```

但这也不会通过编译。

原因是：`self.head` 是 `self` 结构体里的一个字段，而我们拿到的只是 `&mut self`。

`&mut self` 表示“我临时独占借用了这个 `List`，可以修改它”。但它不表示“我拥有整个 `List`”。真正拥有 `List` 的还是调用者：

```rust
let mut list = List::new();
list.push_front(1);

// push_front 返回之后，list 还要继续可用
```

如果在 `push_front` 里直接把 `self.head` move 出来，`list` 就会短暂变成这样：

```rust
List {
    head: <已经被拿走>
}
```

这个状态不是一个完整合法的 `List<T>`。Rust 不允许通过一个可变借用，把被借用对象的字段直接搬空，留下一个“半初始化”的结构体。`&mut self` 允许我们修改字段，但不允许我们让 `self` 处在非法状态里。

**从结构体字段里拿走值时，必须同时留下一个合法的新值。**

Rust 需要我们显式地表达：我要先把 `head` 里的值取走，同时给它留下一个合法的新值。

这个动作可以用 `take()`：

```rust
pub fn push_front(&mut self, elem: T) {
    let new_node = Box::new(Node {
        elem,
        next: self.head.take(),
    });

    self.head = Some(new_node);
}
```

`Option::take()` 做的事情可以理解成：

```rust
let old_head = std::mem::replace(&mut self.head, None);
old_head
```

它把 `self.head` 里的 `Option<Box<Node<T>>>` move 出来，同时立刻把 `self.head` 替换成 `None`。这样 `self` 始终处在一个合法状态。

这一步里有三个所有权变化：

```text
1. self.head.take() 把旧链表的所有权拿出来
2. new_node.next 接管旧链表
3. self.head = Some(new_node) 让 List 接管新节点
```

**`push_front` 的本质不是复制节点，而是重排所有权链。**

所以 `push_front` 不是在复制节点，也不是在手动改裸地址。它是在重新组织所有权。

## pop_front：取走头节点

再写 `pop_front`。逻辑上它要做的事是：

```text
旧链表：
head -> A -> B -> None

弹出 A：
head -> B -> None
返回 A.elem
```

代码可以这样写：

```rust
pub fn pop_front(&mut self) -> Option<T> {
    self.head.take().map(|node| {
        self.head = node.next;
        node.elem
    })
}
```

这里还是先用 `self.head.take()`。因为要把头节点从链表里拿出来，不能只是借用它。

`self.head.take()` 的结果是一个 `Option<Box<Node<T>>>`：

```text
None             -> 空链表，没有东西可弹出
Some(node)       -> 拿到了原来的头节点
```

如果是 `Some(node)`，闭包里的 `node` 拥有那个 `Box<Node<T>>`。也就是说，旧头节点现在已经不属于链表，而属于这个临时变量。

**`pop_front` 必须拿走头节点所有权，因为它要把元素从链表里移除。**

然后：

```rust
self.head = node.next;
```

把旧头节点的 `next` 交还给链表，成为新的头。

最后：

```rust
node.elem
```

把旧头节点里的元素 move 出来，作为返回值。

这个函数的签名也很值得看：

```rust
pub fn pop_front(&mut self) -> Option<T>
```

它返回的是 `T`，不是 `&T`。因为 `pop_front` 的语义是“从链表里移除一个元素，并把这个元素交给调用者”。元素所有权真的被拿走了。

## peek：只看一眼，不拿走

有时候我们只想看看头节点，不想把它弹出来。这时就不能返回 `Option<T>`，因为那会移动元素所有权。

只读查看应该返回引用：

```rust
pub fn peek(&self) -> Option<&T> {
    self.head.as_ref().map(|node| &node.elem)
}
```

这里的 `as_ref()` 很关键。

`self.head` 的类型是：

```rust
Option<Box<Node<T>>>
```

而 `self.head.as_ref()` 会把它变成：

```rust
Option<&Box<Node<T>>>
```

也就是：不拿走 `Option` 里的 `Box`，只借用它。

为什么不能直接写 `self.head.map(...)`？

因为 `Option::map` 会消费它接收的那个 `Option`。它的签名可以粗略看成：

```rust
fn map<U, F>(self, f: F) -> Option<U>
```

注意这里是 `self`，不是 `&self`。所以如果直接写：

```rust
self.head.map(|node| &node.elem)
```

它就会试图把 `self.head` 这个字段 move 出来，也就是把头节点所有权从链表里拿走。

但 `peek(&self)` 只有不可变借用，本来就不能搬走字段；而且从语义上说，`peek` 也只是看一眼，不应该改变链表。

**`map` 会消费 `Option`；`as_ref()` 让它消费的是引用容器。**

所以要先用 `as_ref()` 把拥有型的 `Option<Box<Node<T>>>` 变成引用型的 `Option<&Box<Node<T>>>`。后面的 `map` 消费的只是这个临时的“引用容器”，不是原来的 `self.head`。

```text
self.head.map(...)
  -> 试图消费 Option<Box<Node<T>>>
  -> 会拿走节点所有权

self.head.as_ref().map(...)
  -> 消费 Option<&Box<Node<T>>>
  -> 只借用节点
```

然后 `map(|node| &node.elem)` 返回节点元素的引用。整个返回值是：

```rust
Option<&T>
```

这正好表达了 `peek` 的语义：

```text
如果链表为空，返回 None
如果链表非空，返回头元素的只读引用
```

它没有改变链表，也没有拿走任何元素。

这几个方法可以放在一起记：

```text
self.head.take()    -> 拿走里面的值，并留下 None
self.head.as_ref()  -> 只读借用里面的值
self.head.as_mut()  -> 可变借用里面的值
```

## peek_mut：可以改，但必须独占

如果想修改头元素，可以再加一个 `peek_mut`：

```rust
pub fn peek_mut(&mut self) -> Option<&mut T> {
    self.head.as_mut().map(|node| &mut node.elem)
}
```

这次用的是 `as_mut()`。它把：

```rust
Option<Box<Node<T>>>
```

变成：

```rust
Option<&mut Box<Node<T>>>
```

所以我们可以返回 `&mut node.elem`。

这个函数要求 `&mut self`，不是 `&self`。原因也和第一章讲的一样：可变引用必须独占。

比如下面这样用是可以的：

```rust
let mut list = List::new();
list.push_front(1);

if let Some(value) = list.peek_mut() {
    *value += 10;
}

assert_eq!(list.peek(), Some(&11));
```

但如果一个只读引用还在使用，再去拿可变引用，编译器会拦住：

```rust
let mut list = List::new();
list.push_front(1);

let first = list.peek();
let second = list.peek_mut(); // 编译错误

println!("{first:?} {second:?}");
```

这个例子在 `examples/rust-learning-02/borrow_conflict_error.rs`。真实编译结果是 `E0502`：`list` 已经被不可变借用，不能同时再被可变借用。

![Rust 链表借用验证：peek 返回的不可变引用仍被使用时，peek_mut 所需的可变借用会被 E0502 拦住](https://img.f3dlife.com/blog/2026/06/27/borrow-conflict-error-e990f232-1963-4805-8ce3-be562d3bdd30.png)

**同一个头元素，不能一边被共享读取，一边被独占修改。**

从链表角度看，这个限制很合理。`peek()` 返回的是链表内部元素的引用。如果在这个引用还活着的时候，允许别人通过 `peek_mut()` 修改同一个位置，就会重新落回“共享状态被偷偷修改”的问题。

Rust 不是在针对链表，它是在统一执行借用规则：

```text
要么有多个只读引用，要么有一个独占可变引用。
```

## Deref：为什么 Box 用起来像节点

前面的代码里有一个地方看起来有点奇怪：

```rust
self.head.as_ref().map(|node| &node.elem)
```

`node` 的类型其实是：

```rust
&Box<Node<T>>
```

那为什么可以直接写 `node.elem`？

因为 `Box<T>` 实现了 `Deref`。它允许 `Box<Node<T>>` 在很多场景下像 `Node<T>` 一样被访问。

如果写得更展开一点，可以是：

```rust
self.head.as_ref().map(|node| &(**node).elem)
```

这里：

```text
node      : &Box<Node<T>>
*node     : Box<Node<T>>
**node    : Node<T>
```

但日常代码不会这么写，因为 Rust 会做自动解引用。`Box<T>` 的“智能”有一部分就在这里：它不是一个只会保存地址的裸指针，而是一个带有所有权、释放规则和解引用行为的类型。

**`Box<T>` 像指针一样能解引用，但它还负责拥有和释放堆上的值。**

## iter：生命周期从哪里来

现在链表已经能插入、弹出和查看头元素了。再加一个只读迭代器。

迭代器的特别之处在于：它不是一次性返回一个引用，而是要把“下一个要访问的节点”保存在自己里面。

也就是说，`Iter` 这个结构体里会保存指向链表内部节点的引用。

这里就必须回答一个问题：

```text
Iter 里的引用，是从哪个 List 借来的？
这些引用最多能活多久？
```

如果不把这个关系写进类型，编译器就没法判断下面这种事情安不安全：

```rust
let iter;

{
    let mut list = List::new();
    list.push_front(1);
    iter = list.iter();
}

// 如果 iter 还能用，它里面就保存着已经被释放的 list 节点引用
```

所以这里需要生命周期。它不是为了让语法更复杂，而是为了把“迭代器不能比链表活得更久”这件事写进类型。

**生命周期记录的不是时间长短，而是引用和被引用对象之间的约束。**

一个更通用的判断是：

```text
引用只在函数里临时用       -> 通常不用显式写生命周期
引用要被返回              -> 可能需要生命周期
引用要被结构体保存         -> 通常需要生命周期
多个输入引用和返回引用有关 -> 通常需要生命周期
```

也就是说，如果一个值不拥有数据，只是把别人的引用保存起来，Rust 就需要用生命周期把“它不能比被引用的数据活得更久”这件事写进类型。

先定义迭代器：

```rust
pub struct Iter<'a, T> {
    next: Option<&'a Node<T>>,
}
```

这里的 `next` 不是 `Option<Box<Node<T>>>`。迭代器不拥有节点，它只是沿着链表一路借用节点。

所以它保存的是：

```rust
Option<&'a Node<T>>
```

`'a` 表示：`Iter` 里保存的这些节点引用，都来自某个活在 `'a` 这段时间里的链表。只要 `Iter` 还在用，这个链表就必须还活着。

给 `List` 加一个 `iter` 方法：

```rust
pub fn iter(&self) -> Iter<'_, T> {
    Iter {
        next: self.head.as_deref(),
    }
}
```

这里的 `'_` 是让编译器推断生命周期。它实际表达的是：返回的 `Iter` 借用了当前这个 `&self`，所以 `Iter` 的有效期不能超过这次对 `self` 的借用。

这里用了 `as_deref()`。它可以把：

```rust
Option<Box<Node<T>>>
```

借用成：

```rust
Option<&Node<T>>
```

因为 `Box<Node<T>>` 可以通过 `Deref` 变成 `Node<T>`。

然后实现标准库的 `Iterator` trait：

```rust
impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<Self::Item> {
        self.next.map(|node| {
            self.next = node.next.as_deref();
            &node.elem
        })
    }
}
```

这个 `next()` 方法每次做两件事：

```text
1. 返回当前节点元素的引用
2. 把迭代器里的 next 推进到下一个节点
```

它返回的是 `&'a T`，不是 `T`。这说明迭代器只是借用链表里的元素，不会把元素拿走。

用起来是这样：

```rust
let mut list = List::new();
list.push_front(3);
list.push_front(2);
list.push_front(1);

let values: Vec<_> = list.iter().copied().collect();
assert_eq!(values, vec![1, 2, 3]);
```

这个迭代器里的生命周期不是装饰语法。它表达的是一个很具体的约束：

```text
只要迭代器还在返回节点引用，原来的链表就必须还活着。
```

这和第一章里讲的“引用不能比对象活得更久”是同一件事，只是现在放进了一个真实数据结构里。

## Drop：整条链表什么时候释放

现在看完整链表：

```rust
pub struct List<T> {
    head: Link<T>,
}

type Link<T> = Option<Box<Node<T>>>;

struct Node<T> {
    elem: T,
    next: Link<T>,
}
```

当 `List<T>` 离开作用域时，`head` 会被 drop。  
如果 `head` 是 `Some(Box<Node<T>>)`，这个 `Box` 会释放它拥有的 `Node<T>`。  
这个 `Node<T>` 被释放时，它的 `next` 字段也会被 drop。  
于是下一个 `Box<Node<T>>` 继续释放下一个节点。

所以从语义上看，整条链表会沿着所有权链自动释放：

```text
List drop
  head drop
    first node drop
      next drop
        second node drop
          next drop
            ...
```

这和 C 里的手写释放循环有点像：

```c
while (head != NULL) {
    struct Node *next = head->next;
    free(head);
    head = next;
}
```

区别是，Rust 不需要我们在普通场景里手写 `free`。只要所有权关系表达清楚，释放路径就跟着类型结构走。

不过这里也有一个值得注意的边界：默认的递归 drop 在链表特别长时，理论上可能造成很深的递归释放。很多教程会为链表手写一个迭代版 `Drop`，把节点一个个取出来释放。

可以这样写：

```rust
impl<T> Drop for List<T> {
    fn drop(&mut self) {
        let mut current = self.head.take();

        while let Some(mut boxed_node) = current {
            current = boxed_node.next.take();
        }
    }
}
```

这段代码没有显式调用 `free`。它只是不断把 `next` 从当前节点里 `take()` 出来，让当前这个 `Box<Node<T>>` 在循环末尾自然 drop。这样释放过程就变成了迭代，而不是一层层递归。

**手写 `Drop` 不是为了手动释放内存，而是为了控制释放链表节点的方式。**

再次看到 `take()`，它的作用还是同一个：

```text
把 Option 里的值拿走，同时留下 None。
```

## 完整代码和运行结果

核心实现合在一起大概是这样。完整可运行版本放在 `examples/rust-learning-02/list_stack.rs`，里面额外写了一个 `main` 来打印每一步结果。

```rust
pub struct List<T> {
    head: Link<T>,
}

type Link<T> = Option<Box<Node<T>>>;

struct Node<T> {
    elem: T,
    next: Link<T>,
}

pub struct Iter<'a, T> {
    next: Option<&'a Node<T>>,
}

impl<T> List<T> {
    pub fn new() -> Self {
        List { head: None }
    }

    pub fn push_front(&mut self, elem: T) {
        let new_node = Box::new(Node {
            elem,
            next: self.head.take(),
        });

        self.head = Some(new_node);
    }

    pub fn pop_front(&mut self) -> Option<T> {
        self.head.take().map(|node| {
            self.head = node.next;
            node.elem
        })
    }

    pub fn peek(&self) -> Option<&T> {
        self.head.as_ref().map(|node| &node.elem)
    }

    pub fn peek_mut(&mut self) -> Option<&mut T> {
        self.head.as_mut().map(|node| &mut node.elem)
    }

    pub fn iter(&self) -> Iter<'_, T> {
        Iter {
            next: self.head.as_deref(),
        }
    }
}

impl<T> Drop for List<T> {
    fn drop(&mut self) {
        let mut current = self.head.take();

        while let Some(mut boxed_node) = current {
            current = boxed_node.next.take();
        }
    }
}

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<Self::Item> {
        self.next.map(|node| {
            self.next = node.next.as_deref();
            &node.elem
        })
    }
}
```

如果放进测试里，也可以写几个简单断言验证一下：

```rust
let mut list = List::new();

assert_eq!(list.pop_front(), None);

list.push_front(1);
list.push_front(2);
list.push_front(3);

assert_eq!(list.peek(), Some(&3));

if let Some(value) = list.peek_mut() {
    *value = 30;
}

assert_eq!(list.peek(), Some(&30));

let values: Vec<_> = list.iter().copied().collect();
assert_eq!(values, vec![30, 2, 1]);

assert_eq!(list.pop_front(), Some(30));
assert_eq!(list.pop_front(), Some(2));
assert_eq!(list.pop_front(), Some(1));
assert_eq!(list.pop_front(), None);
```

我也用一个带 `println!` 的版本跑了一遍，输出能对应上 `push_front`、`peek_mut`、`iter` 和 `pop_front` 的行为：

![Rust 链表运行验证：完整 List 示例可以 push、peek_mut、iter 和 pop，最终空链表返回 None](https://img.f3dlife.com/blog/2026/06/27/list-stack-8c6b8bc7-3f02-4f4c-98fe-8755a544b19b.png)

## 我现在的理解

这一版链表没有用到复杂语法，但它把 Rust 的几个核心概念都串起来了。

`Box<T>` 解决的是递归类型的大小问题，也是“堆上对象由谁拥有”的问题。它像指针，但不是裸地址；它带着所有权，离开作用域会释放资源。

`Option<Box<Node<T>>>` 解决的是链表结尾的问题。C 里用 `NULL`，Rust 里用 `None`。这让“可能为空”变成类型的一部分，而不是一个运行时约定。

`take()` 解决的是“从结构体字段里拿走所有权”的问题。它不是小技巧，而是在告诉编译器：我会把这个位置先换成一个合法值，再拿走原来的值。

`peek` 和 `peek_mut` 则再次说明了借用规则。只看一眼，用 `&T`；要修改，用 `&mut T`；只要可变借用存在，就必须独占。

`Iter<'a, T>` 把生命周期放进了具体场景：迭代器返回的是链表内部元素的引用，所以它不能比链表活得更久。

如果把这些都翻译回 C 的问题，大概是：

```text
struct Node *next        -> Box<Node<T>>
NULL                     -> None
malloc 一个节点           -> Box::new(Node { ... })
把 head 接到新节点后面     -> self.head.take()
返回节点里的值             -> move 出 T
只查看节点里的值           -> 返回 &T
修改节点里的值             -> 返回 &mut T
释放整条链表               -> Drop 沿着所有权链释放
```

这就是我觉得 Rust 很有意思的地方：它并没有让链表这个数据结构变神秘。它只是要求我们把 C 里那些靠习惯维护的约定，写进类型和所有权关系里。

## 小结

这一章先记住这几件事：

1. 递归类型不能直接包含自己，需要用指针形态切开；在 Rust 里通常先想到 `Box<T>`。
2. 链表结尾不要用空指针思维硬猜，应该用 `Option` 明确表达。
3. 修改链表头时，`take()` 是把字段里的所有权安全拿出来的常用方式。
4. `pop_front` 返回 `T`，表示拿走元素；`peek` 返回 `&T`，表示只是借用元素。
5. 智能指针的“智能”，不是自动替我们设计数据结构，而是把所有权、释放和解引用这些规则封装进类型。

当然，实际写业务代码时，Rust 里不一定优先选择链表。很多时候 `Vec<T>` 或 `VecDeque<T>` 更简单，也更符合 CPU 缓存。但作为理解所有权、堆分配、递归类型和借用关系的练习，手写一遍链表很值。
