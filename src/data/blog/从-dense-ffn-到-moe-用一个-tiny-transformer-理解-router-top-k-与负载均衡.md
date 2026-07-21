---
title: "从 Dense FFN 到 MoE：用一个 Tiny Transformer 理解 Router、Top-K 与负载均衡"
author: F3D
pubDatetime: 2026-07-21T13:55:07+08:00
description: "沿一个可运行的两层 Tiny Transformer，拆开 Dense FFN、SwiGLU、Top-K 路由、expert dispatch/combine 与负载均衡。"
tags:
  - release
  - ai
  - transformer
  - moe
draft: false
---

MoE 最容易产生的误解，是把“稀疏模型”想成权重矩阵里有大量参数为零。主流 Transformer MoE 通常不是这种稀疏：每个 expert 内部仍是稠密矩阵，只是一个 token 不会执行所有 experts。

这带来一串必须连起来回答的问题：MoE 替换 Transformer 的哪一部分？一个 expert 到底是什么？Router 的 Top-K 输出如何变成真实计算？多个 expert 的结果怎样回到原 token？为什么已经统计了概率，还要再统计实际负载？

本文沿一个两层、四 expert、Top-2 的 Tiny Transformer 走完这条路径。示例在 Python 3.12、PyTorch 2.11、CPU 环境运行 301 个训练 step，并保留 KV cache，便于确认 MoE 改写的是 FFN，而不是 attention 的历史读取机制。完整代码位于 `examples/tiny-moe/tiny_moe.py`。

```bash
uv run --with torch==2.11.0 --with numpy python examples/tiny-moe/tiny_moe.py
```

如果 QKV、causal mask 和 KV cache 还没有连成一条线，可以先看站内前文：[从 QKV 到 KV Cache：一步步理解 Transformer 训练与大模型推理](/posts/从-qkv-到-kv-cache-一步步理解-transformer-训练与大模型推理/)。

![一个 token hidden tensor 经过 Attention、Top-2 Router、四个 SwiGLU experts，再按原 token 位置加权合并回 residual stream](https://img.f3dlife.com/blog/2026/07/21/tiny-moe-flow-420f85a5-af81-4991-964d-51d6bead6a6c.png)
Fig. Tiny MoE block 的关键不是“并行执行全部 experts”，而是先按 token dispatch，只执行 Top-2 子批次，再用路由权重与原 token 下标恢复 `[B,T,D]`。

## 目录

- [1 MoE 替换的是 FFN，不是整层 Transformer](#1-moe-替换的是-ffn不是整层-transformer)
- [2 Dense FFN 为什么本来就是参数大户](#2-dense-ffn-为什么本来就是参数大户)
- [3 一个 expert：从 GELU FFN 到 SwiGLU](#3-一个-expert从-gelu-ffn-到-swiglu)
- [4 Router：从 soft probability 到 hard Top-K](#4-router从-soft-probability-到-hard-top-k)
- [5 Dispatch：`torch.where` 找到 token 与 route slot](#5-dispatchtorchwhere-找到-token-与-route-slot)
- [6 Combine：`index_add` 把 Top-K 输出加回原 token](#6-combineindex_add-把-top-k-输出加回原-token)
- [7 MoE 的稀疏到底体现在哪里](#7-moe-的稀疏到底体现在哪里)
- [8 为什么 importance 和 load 不能只留一个](#8-为什么-importance-和-load-不能只留一个)
- [9 反向传播如何训练 Router 和 experts](#9-反向传播如何训练-router-和-experts)
- [10 两层实验：每层 Router 独立，KV cache 保持不变](#10-两层实验每层-router-独立kv-cache-保持不变)
- [11 从 Tiny MoE 映射到 MiniMax M3](#11-从-tiny-moe-映射到-minimax-m3)
- [12 教学实现与生产 MoE 的边界](#12-教学实现与生产-moe-的边界)
- [13 最终工作模型](#13-最终工作模型)
- [参考资料](#参考资料)

## 1 MoE 替换的是 FFN，不是整层 Transformer

一个常见的 pre-norm decoder block 可以写成：

```text
X
├─ Norm → Self-Attention → output projection ─┐
└──────────────────────────────────────────────+ → R

R
├─ Norm → FFN/MLP ────────────────────────────┐
└──────────────────────────────────────────────+ → X(next layer)
```

这里的 FFN 与 MLP 在 Transformer 语境中通常指同一个模块：`MLP` 描述“多层线性变换加非线性激活”的结构，`FFN` 描述它在 block 中承担的前馈子层角色。它们都逐 token 工作：

```text
y[b,t] = FFN(x[b,t])
```

同一层的所有 token 共享同一套 FFN 参数，但 FFN 本身不会让位置 `t` 读取位置 `t-1`。跨 token 的信息交换已经由 attention 完成；FFN 加工的是已经吸收上下文的单 token 表示。

Dense block 与 MoE block 的差别发生在第二个子层：

```text
Dense block: Attention → 一个 Dense FFN
MoE block:   Attention → Router → 多个 FFN experts 中的 Top-K
```

因此标准 MoE 不是先连续堆很多层 attention，最后统一进入一次 experts。它仍按层执行：

```text
Layer 0: Attention 0 → Router 0 → Experts 0
Layer 1: Attention 1 → Router 1 → Experts 1
Layer 2: Attention 2 → Router 2 → Experts 2
```

每层有独立的 attention、Router 和 expert 参数。也有模型只把部分层改成 MoE，保留若干 Dense FFN 层。

## 2 Dense FFN 为什么本来就是参数大户

设 residual hidden size 为 `D`。标准 Multi-Head Attention 有四个主要投影：

```text
Wq: [D,D]
Wk: [D,D]
Wv: [D,D]
Wo: [D,D]
```

忽略 bias，参数量约为：

```text
Attention parameters ≈ 4D²
```

经典 Transformer FFN 使用 `D → 4D → D`：

```text
W_up:   [D,4D]
W_down: [4D,D]

FFN parameters ≈ 8D²
```

所以在一个经典 Dense block 内，FFN 参数量天然约为 attention 投影的两倍。增加 head 数但保持 `D` 不变，只是在重新切分 `D = H × Dh`，不会把 QKV 参数量直接放大；扩大 FFN intermediate dimension，则能在不改变 residual shape、embedding、KV cache shape 和层间接口的前提下增加特征加工容量。

这不是说 attention 不重要，也不是所有模型都只能按 `4D² : 8D²` 分配参数。GQA、MLA、稀疏 attention 和不同 FFN expansion ratio 都会改变比例。这里要抓住的是：**Dense FFN 本来就是 block 的参数大户，而且它逐 token、输入输出 shape 固定，最适合复制成条件执行的 experts。**

## 3 一个 expert：从 GELU FFN 到 SwiGLU

经典 FFN 是：

```python
self.mlp = nn.Sequential(
    nn.Linear(d_model, 4 * d_model),
    nn.GELU(),
    nn.Linear(4 * d_model, d_model),
)
```

如果去掉 GELU，两层 Linear 可以合并成一层，升维就失去了大部分意义。非线性激活让不同中间特征可以按输入被增强或抑制。

很多现代 LLM 使用 SwiGLU。一个 SwiGLU expert 有三套矩阵：

```python
class SwiGLU(nn.Module):
    def __init__(self, d_model: int, hidden_dim: int):
        super().__init__()
        self.gate_proj = nn.Linear(d_model, hidden_dim, bias=False)
        self.up_proj = nn.Linear(d_model, hidden_dim, bias=False)
        self.down_proj = nn.Linear(hidden_dim, d_model, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        hidden = F.silu(self.gate_proj(x)) * self.up_proj(x)
        return self.down_proj(hidden)
```

对应公式：

```text
gate   = SiLU(x W_gate)
value  = x W_up
hidden = gate ⊙ value
output = hidden W_down
```

`value` 提供候选特征，`gate` 决定这些特征通过多少。SwiGLU 有三个 `D×F` 量级的矩阵，参数量约为 `3DF`。若希望与经典 `8D²` FFN 大致对齐，可以取：

```text
F ≈ 8D/3
```

Tiny MoE 使用 `D=32`、每个 expert 的 `F=48`。单个 expert 的参数量是：

```text
3 × 32 × 48 = 4,608
```

**Expert 并不是一个完整 Transformer layer；在这个实现里，它就是一套独立的 SwiGLU FFN。**

## 4 Router：从 soft probability 到 hard Top-K

进入 MoE 前，hidden states 的 shape 是 `[B,T,D]`。Router 不关心 batch 与序列的二维组织，先把 token 展平：

```python
batch_size, length, d_model = x.shape
tokens = x.reshape(-1, d_model)
```

定义：

| 符号 | 含义 |
| --- | --- |
| `N=B×T` | 当前 MoE 层收到的 token 总数 |
| `D` | residual hidden size |
| `E` | expert 数量 |
| `K` | 每个 token 选择的 expert 数量 |
| `F` | 单个 expert 的 intermediate dimension |

本实验中：

```text
[B,T,D] = [2,64,32]
[N,D]   = [128,32]
E       = 4
K       = 2
```

Router 是一个很小的线性层：

```python
self.router = nn.Linear(d_model, num_experts, bias=False)

router_logits = self.router(tokens)       # [N,D] → [N,E]
router_probs = F.softmax(router_logits, dim=-1)
```

`router_probs[t,e]` 表示 token `t` 分给 expert `e` 的软概率。随后选择每行最大的 `K` 项：

```python
topk_weights, topk_indices = torch.topk(
    router_probs, self.top_k, dim=-1
)
topk_weights = topk_weights / topk_weights.sum(
    dim=-1, keepdim=True
)
```

假设某个 token 的 Router 输出为：

```text
router_probs = [0.10, 0.20, 0.60, 0.10]
```

Top-2 得到：

```text
topk_indices = [2, 1]
topk_weights = [0.60, 0.20]
renormalized = [0.75, 0.25]
```

未选中的两个 experts 不执行。重新归一化后，两个保留权重之和为 1。

## 5 Dispatch：`torch.where` 找到 token 与 route slot

对整个 batch，`topk_indices` 的 shape 是 `[N,K]`。例如：

```python
topk_indices = torch.tensor([
    [2, 0],  # token 0
    [1, 2],  # token 1
    [3, 0],  # token 2
    [2, 1],  # token 3
])
```

循环处理 `expert_id=2` 时：

```python
token_indices, route_slots = torch.where(
    topk_indices == expert_id
)
```

比较产生的布尔矩阵是：

```text
[[ True, False],
 [False,  True],
 [False, False],
 [ True, False]]
```

`torch.where` 返回所有 `True` 的二维坐标：

```text
token_indices = [0, 1, 3]
route_slots   = [0, 1, 0]
```

两列必须一起理解：

```text
(0,0): token 0 的第 0 个选择是 expert 2
(1,1): token 1 的第 1 个选择是 expert 2
(3,0): token 3 的第 0 个选择是 expert 2
```

于是当前 expert 的输入可以一次取出：

```python
expert_input = tokens[token_indices]  # [n_e,D]
expert_output = expert(expert_input)  # [n_e,D]
```

这比逐 token 调用 expert 更接近真实系统的计算方式：先按 expert 聚合 token，再形成较大的矩阵乘法。教学实现仍使用 Python 循环；生产实现通常会继续把这里改造成 grouped GEMM 和跨设备 token dispatch。

## 6 Combine：`index_add` 把 Top-K 输出加回原 token

`route_slots` 的作用，是从 `[N,K]` 中取到当前 route 的准确权重：

```python
weights = topk_weights[token_indices, route_slots].unsqueeze(-1)
```

若当前 expert 收到 3 个 token：

```text
topk_weights[token_indices, route_slots]: [3]
unsqueeze(-1):                           [3,1]
expert_output:                           [3,D]
```

`[3,1]` 会广播到 hidden dimension，得到每条 route 对最终 token 输出的加权贡献：

```python
weighted_output = weights * expert_output  # [3,D]
```

`combined` 最初是 `[N,D]` 的零张量：

```python
combined = torch.zeros_like(tokens)
combined = combined.index_add(
    0,
    token_indices,
    weighted_output,
)
```

`dim=0` 表示沿 token 维累加，`token_indices` 指定每个 expert 输出应该回到哪一行。假设 token 0 选择 Expert 2 和 Expert 0：

```text
combined[0]
= 0.75 × Expert_2(tokens[0])
= 0.25 × Expert_0(tokens[0])
```

最终就是：

```text
MoE(x_t) = Σ weight(t,e) × Expert_e(x_t)
           e∈TopK(t)
```

这里必须使用累加而不是赋值。赋值会让后处理的 expert 覆盖前一个 expert，Top-2 退化成只剩最后一路。所有 experts 处理完成后，再把 `[N,D]` reshape 回 `[B,T,D]`，与 residual 相加。

## 7 MoE 的稀疏到底体现在哪里

本实验有 4 个 experts，每个 token 只选择 2 个。每个 expert 内部的三个矩阵仍是稠密矩阵：

```text
一个 expert:     3 × D × F = 3 × 32 × 48 = 4,608
四个 experts:    4 × 4,608 = 18,432
Router:           D × E = 32 × 4 = 128
```

一个 token 实际使用的 MoE 参数约为：

```text
Router + Top-2 experts
= 128 + 2 × 4,608
= 9,344
```

作为参照，参数量对齐的 Dense SwiGLU 可取 `F=88`：

```text
Dense SwiGLU = 3 × 32 × 88 = 8,448
```

因此这个 Tiny 配置把 FFN 总参数从约 8.4K 增加到约 18.6K，但单 token 激活约 9.3K，计算量保持在同一量级。它不是严格 FLOPs 对齐：Router、dispatch、不同 expert batch size 都有额外成本；这个数字只用来固定“总参数”和“每 token 激活参数”的区别。

**MoE 的稀疏是逐 token 的条件计算，不是 expert 权重矩阵里大量元素为零。**

还要注意 batch 视角：虽然一个 token 只走 Top-2，但一个 batch 的不同 token 可能覆盖全部 4 个 experts。稀疏不等于整个 step 只加载两个 experts；大模型通常要存储全部 expert 权重，并把它们分布在多张设备上。

## 8 为什么 importance 和 load 不能只留一个

Router 如果持续偏向少数 experts，会导致 expert collapse：热门 expert 过载，其他 expert 很少获得 token 和梯度。示例使用一个简化的负载均衡辅助损失：

```python
importance = router_probs.mean(dim=0)

hard_routes = F.one_hot(
    topk_indices,
    num_classes=self.num_experts,
).float()
load = hard_routes.mean(dim=(0, 1))

load_balance_loss = self.num_experts * torch.sum(
    importance * load
)
```

两者相关，但不相同：

```text
importance：Top-K 前，Router 分给各 expert 的平均软概率
load：      Top-K 后，各 expert 实际收到的 route 比例
```

考虑 2 个 token、2 个 experts、Top-1。下面两组 Router 概率有相同的 importance：

```text
情况 A
token 0: [0.51, 0.49] → Expert 0
token 1: [0.51, 0.49] → Expert 0
importance = [0.51,0.49]
load       = [1.00,0.00]

情况 B
token 0: [0.99, 0.01] → Expert 0
token 1: [0.03, 0.97] → Expert 1
importance = [0.51,0.49]
load       = [0.50,0.50]
```

因此不能从已经聚合的 `importance` 推导实际 `load`。反过来，相同 load 也可能对应置信度完全不同的 soft probability。

为什么不直接最小化 load 的不均匀程度？因为 `load` 来自离散 `topk_indices`。概率从 `[0.51,0.49]` 变成 `[0.52,0.48]` 时，硬选择完全不变；越过排序边界时又突然跳变。这条路径不能提供普通的连续梯度。

`importance` 来自 softmax，是可微分的；`load` 则告诉损失当前哪些 experts 实际过载。训练时可以把 hard load 看成当前 step 的系数，通过 importance 把压力传回 Router。

令：

```text
p_e = expert e 的平均 soft probability
f_e = expert e 的实际 route 比例
E   = expert 数量
```

辅助损失是：

```text
L_balance = E × Σ(p_e × f_e)
```

当 `p_e=f_e=1/E` 时，参考值为 1。本文实验里的 `router aux` 接近 1，表示没有出现严重集中；它不是一个需要无限趋近 0 的 loss，也不是负载均衡的唯一实现。现代 MoE 还会使用 expert bias、capacity constraint、Sinkhorn 或 auxiliary-loss-free routing 等方法。

## 9 反向传播如何训练 Router 和 experts

“Feed-Forward” 只描述前向计算没有循环连接，不表示 FFN 不能反向传播。Dense FFN、SwiGLU expert 和 Router 都包含可训练参数。

训练目标写成：

```python
total_loss = language_model_loss + 0.01 * router_aux_loss
total_loss.backward()
optimizer.step()
```

梯度路径可以分成三类：

1. 被选中的 expert：language model loss 会更新它的 `gate/up/down` 矩阵；
2. 未被某 token 选中的 expert：不会从这个 token 获得梯度，但可能从 batch 中其他 token 获得梯度；
3. Router：selected route weights 会从主任务 loss 获得梯度，soft importance 还会从负载均衡 loss 获得梯度。

`topk_indices` 本身是离散整数，不能像普通浮点 activation 那样求导。训练并不是对“Expert 2”这个编号求梯度，而是在当前选择固定时，对被选中的概率权重、Router logits 和 expert 输出求梯度。路由排序发生变化，是参数经过多次连续更新后跨过 Top-K 边界的结果。

## 10 两层实验：每层 Router 独立，KV cache 保持不变

示例使用两个 Transformer MoE blocks。相同的 `[2,64,32]` 输入经过不同层后，Router 输出了不同分配：

```text
layer 0 assignments before training: [88,71,45,52]
layer 1 assignments before training: [58,72,69,57]
```

每层一共有 `N×K = 128×2 = 256` 条 routes，两组计数之和都等于 256。这也直接证明：每层有自己的 Router，后一层不会复用前一层的 expert 选择。

完整脚本的真实运行输出如下：

![Tiny MoE 两层 Router shape、expert 分配、301 步训练 loss、KV cache 一致性与生成结果](https://img.f3dlife.com/blog/2026/07/21/tiny-moe-run-859d496f-db86-4900-8603-fd0af1e4cad3.png)
Fig. 两层 Router 都接收 128 个 token，却产生不同 expert 分配；LM loss 持续下降，同时 cached decode 与 full-prefix logits 保持数值一致。

需要关注三组结果。

第一，语言模型 loss 从 `3.2122` 降到 `0.0398`，说明 selected experts、Router 和其余 Transformer 参数确实可以共同反向传播。

第二，训练后的第二层分配为 `[70,57,65,64]`，四个 experts 都获得了 routes。负载均衡 loss 约为 `1.0`，没有出现把全部 token 塞给单个 expert 的明显 collapse。

第三：

```text
full vs cached max logits difference: 0.00000334
layers cached: 2
layer 0 K/V: (1,4,48,8) each
```

MoE 没有替代 KV cache。每层 attention 仍缓存自己的 K/V；decode 时新 token 先读取历史 K/V，再进入该层 Router 和 experts。MoE 改的是当前 token 的 FFN 参数路径，不是 attention 的历史状态结构。

## 11 从 Tiny MoE 映射到 MiniMax M3

截至 2026 年 7 月，MiniMax M3 官方配置给出了一个更完整的混合架构实例：约 428B 总参数、约 23B 每 token 激活参数，语言 backbone 有 60 层，hidden size 为 6144。

| 配置 | MiniMax M3 |
| --- | --- |
| Decoder layers | 60 |
| Dense/MoE 排布 | 前 3 层 Dense，后 57 层 MoE |
| Routed experts | 每个 MoE 层 128 个 |
| Top-K | 每 token 选择 4 个 routed experts |
| Shared expert | 每个 MoE 层另有 1 个始终执行的 shared expert |
| Routed/shared intermediate size | 3072 |
| Dense intermediate size | 12288 |
| Attention | 64 query heads、4 KV heads、head dimension 128 |
| Sparse attention | 前 3 层关闭，后 57 层启用 MSA |

把它映射回 Tiny MoE：

```text
Tiny:  E=4,   K=2, 每层独立 Router, 无 shared expert
M3:    E=128, K=4, 每层独立 Router, +1 shared expert
```

M3 还同时使用 MiniMax Sparse Attention。两种“稀疏”作用在不同轴上：

```text
MSA：为 query 选择少量相关 KV blocks
MoE：为 token 选择少量相关 FFN experts
```

所以 M3 仍然逐层执行 `Attention → MoE FFN`。不是先跑完 60 层 attention，再统一经过一次 expert pool；也不是把整个 Transformer layer 当作一个 expert。

## 12 教学实现与生产 MoE 的边界

Tiny MoE 固定了核心计算图，但没有伪装成生产实现。它与大规模系统至少有五个差异。

### 12.1 Python 循环不是高性能 dispatch

示例逐 expert 执行：

```python
for expert_id, expert in enumerate(self.experts):
    token_indices, route_slots = torch.where(
        topk_indices == expert_id
    )
    ...
```

这便于观察坐标和权重。真实系统会做 token permutation、grouped GEMM，并在 expert parallel 场景通过 All-to-All 把 token 发往持有目标 expert 的设备。

### 12.2 没有 capacity limit

如果大量 token 选择同一个 expert，示例会让它全部执行。生产系统通常要定义 expert capacity、overflow 处理和负载均衡策略，否则最忙的 expert 会形成尾延迟和显存峰值。

### 12.3 没有 shared expert

Tiny 模型只实现 routed experts。DeepSeekMoE、MiniMax M3 等架构还会加入始终激活的 shared expert，让通用特征不必在多个 routed experts 中重复学习。

### 12.4 参数量相近不等于运行成本相同

即使 Top-K active expert 参数与 Dense FFN 接近，Router、排序、token 重排、跨卡通信和不规则 expert batch 都会产生额外开销。MoE 是否更快取决于 kernel、并行布局、batch 和通信，而不能只看 active parameter 数字。

### 12.5 专家分工不是人工标签

代码没有规定 Expert 0 必须处理语法、Expert 1 必须处理代码。和 QKV 一样，计算图只规定岗位，具体表示由训练产生。expert specialization 可以通过路由统计分析，但不应仅凭编号赋予语义。

## 13 最终工作模型

从 Dense Transformer 到 MoE，可以压缩成四步。

第一步，Dense Transformer 每层都有 attention 和一个逐 token FFN：

```text
Attention：跨 token 读取信息
FFN：      在单 token 内变换特征
```

第二步，把一套 Dense FFN 复制成多套独立 SwiGLU experts。参数总量随 expert 数增加，但每个 token 不再执行全部参数。

第三步，每层 Router 对 `[N,D]` 产生 `[N,E]` 概率，Top-K 把软概率变成离散 dispatch；各 expert 只计算收到的 token 子批次。

第四步，用 route weight 加权 expert 输出，再按原 token index 累加回 `[N,D]`，reshape 为 `[B,T,D]`，继续 residual stream：

```text
MoE(x_t) = Σ weight(t,e) × Expert_e(x_t)
```

**MoE 扩大的是模型可容纳的 FFN 参数集合，稀疏的是每个 token 实际经过的计算路径。** Attention、KV cache、逐层执行和反向传播仍然存在；真正新增的系统问题，是离散路由之后的负载、通信与高效矩阵计算。

## 参考资料

- Jacobs et al., [Adaptive Mixtures of Local Experts](https://www.cs.toronto.edu/~hinton/absps/jjnh91.pdf), 1991.
- Shazeer et al., [Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer](https://arxiv.org/abs/1701.06538), 2017.
- Shazeer, [GLU Variants Improve Transformer](https://arxiv.org/abs/2002.05202), 2020.
- Lepikhin et al., [GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding](https://arxiv.org/abs/2006.16668), 2020.
- Fedus et al., [Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity](https://arxiv.org/abs/2101.03961), 2021.
- Dai et al., [DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models](https://arxiv.org/abs/2401.06066), 2024.
- MiniMaxAI, [MiniMax-M3 model card](https://huggingface.co/MiniMaxAI/MiniMax-M3) 与 [config.json](https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/main/config.json), 2026.
- MiniMaxAI, [MiniMax Sparse Attention](https://arxiv.org/abs/2606.13392), 2026.
