---
title: "从 QKV 到 KV Cache：一步步理解 Transformer 训练与大模型推理"
author: F3D
pubDatetime: 2026-07-20T16:29:01+08:00
description: "沿一个可运行的 Tiny Transformer，把 QKV、causal mask、反向传播、AdamW、KV cache、prefill/decode 与 MaaS 调度串成同一条路径。"
tags:
  - release
  - ai
  - transformer
  - inference
draft: false
---

Transformer 容易被公式切碎：先是 embedding，接着是 QKV 和 attention，然后突然出现 causal mask、反向传播、AdamW；到了推理系统，又变成 KV cache、prefill、decode、continuous batching 和外部存储。

这些并不是几套互不相干的知识。它们围绕的是同一个问题：**一个 token 的表示如何产生、如何从历史 token 读取信息、参数如何因此被训练，以及相同计算在在线生成时如何避免重复。**

本文用一个两层、四头、字符级的 Tiny Transformer 固化这条路径。示例基于 PyTorch 2.11，在 CPU 上完成 301 个训练 step，并验证 full-prefix 与 cached decoding 的 logits 一致性。完整代码保存在仓库的 `examples/transformer-qkv-kv-cache/tiny_transformer.py`。

![文本经过 token 和 embedding 后，在训练阶段进入并行 causal attention 与反向传播，在推理阶段进入 prefill、逐层 KV cache 和单 token decode](https://img.f3dlife.com/blog/2026/07/20/training-inference-path-e57a24bf-f80d-4cb4-872b-c51d72c1e576.png)
Fig. 同一个模型有两种执行形态：训练时整段序列并行计算，推理时先 prefill，再用逐层 KV cache 驱动单 token decode；两边遵守同一条 causal 规则。

## 目录

- [1 从文本到 residual stream](#1-从文本到-residual-stream)
- [2 QKV 的角色由计算图规定，语义由训练产生](#2-qkv-的角色由计算图规定语义由训练产生)
- [3 多头 attention 的 shape 到底怎么变](#3-多头-attention-的-shape-到底怎么变)
- [4 causal mask：可以回看过去，不能偷看未来](#4-causal-mask可以回看过去不能偷看未来)
- [5 一个完整 Transformer block 还有什么](#5-一个完整-transformer-block-还有什么)
- [6 训练：loss、反向传播与 AdamW 分别负责什么](#6-训练loss反向传播与-adamw-分别负责什么)
- [7 推理为什么像 RNN，却仍然不是 RNN](#7-推理为什么像-rnn却仍然不是-rnn)
- [8 KV cache 为什么只缓存 K/V，而且每层都要缓存](#8-kv-cache-为什么只缓存-kv而且每层都要缓存)
- [9 prefill、decode 与 mask 的边界](#9-prefilldecode-与-mask-的边界)
- [10 Agent、1M context 与 prefix cache](#10-agent1m-context-与-prefix-cache)
- [11 MaaS 一次能服务多少请求](#11-maas-一次能服务多少请求)
- [12 KV cache 能不能放到外部存储](#12-kv-cache-能不能放到外部存储)
- [13 现代 attention 与 MoE 的关系](#13-现代-attention-与-moe-的关系)
- [14 最终工作模型](#14-最终工作模型)
- [参考资料](#参考资料)

## 1 从文本到 residual stream

模型不会直接接收字符串。第一步是 tokenizer 把文本变成 token ID：

```text
"attention" -> [4, 16, 16, 7, 12, 16, 10, 13, 12]
```

真实 LLM 通常使用 BPE、Unigram 或其他 subword tokenizer；本文为了把全部代码放在一个文件里，使用字符 tokenizer。机制没有变化：token ID 只是词表里的整数索引，它本身还不是模型可以做线性代数的向量。

Embedding table 可以看成一个可训练的查找表：

```text
token_embedding.weight: [V, D]
token_ids:               [B, T]
lookup result:           [B, T, D]
```

这里四个符号会贯穿全文：

| 符号 | 含义 |
| --- | --- |
| `B` | batch size，一次并行处理多少条序列 |
| `T` | sequence length，上下文里有多少 token |
| `D` | `d_model`，每个 token 的 hidden dimension |
| `V` | vocabulary size，词表大小 |

位置 embedding 与 token embedding 相加后，得到第 0 层的 hidden states：

```text
X(0) = token_embedding(token_ids) + position_embedding(positions)
X(0): [B, T, D]
```

很多现代模型用 RoPE，而不是这种 learned absolute position embedding。但无论位置如何编码，Transformer block 真正接收的都是一组 token 向量。它们共同构成贯穿各层的 residual stream。

`batch_size` 不属于模型权重的 shape。模型定义 `Wq: [D, D]`，运行时才从输入读出 `B` 和 `T`。因此同一模型可以接收 `[8, 64]` 或 `[32, 64]` 的 token IDs，只要显存、kernel 和部署配置允许。

不过 batch 不是一个纯粹的 OOM 开关。训练时它改变梯度统计和有效 batch；推理时它改变吞吐、排队时间和 KV cache 占用。后面 MaaS 调度会回到这个边界。

## 2 QKV 的角色由计算图规定，语义由训练产生

进入 attention 后，同一个 `X` 经过三套不同的线性投影：

```python
q = self.query(normalized)
k = self.key(normalized)
v = self.value(normalized)
```

数学关系是：

```text
Q = X Wq
K = X Wk
V = X Wv
```

需要分清两类对象：

```text
Wq、Wk、Wv：模型参数，被 optimizer 更新并写入 checkpoint
Q、K、V：本次输入产生的 activation，随输入和层数变化
```

我们人为规定了它们在计算图中的岗位：

```text
scores  = Q K^T / sqrt(dk)
weights = softmax(scores)
output  = weights V
```

因此可以把三者理解为：

- `Q`：当前位置想找什么；
- `K`：每个位置可以如何被匹配；
- `V`：匹配后实际提供什么内容。

但模型设计者没有指定某一维必须表示“主语”“否定”或“时间”。训练开始时 `Wq/Wk/Wv` 近似随机，QKV 也没有这些人工语义。语言模型 loss 通过反向传播调整投影矩阵，最终让某些 head 学到有用的匹配和读取模式。

所以更准确的结论是：**QKV 的结构性职责由 attention 计算图规定，具体编码什么特征由训练产生。**

点积也不是唯一的匹配函数。Attention 的通用结构是：

```text
score(i, j) = compatibility(q_i, k_j)
weight(i, j) = softmax_j(score(i, j))
output_i = sum_j weight(i, j) * v_j
```

`compatibility` 可以是 scaled dot product、additive network、bilinear function 或 cosine similarity。Transformer 选择 scaled dot-product，一个关键工程原因是它能落到高度优化的大矩阵乘法上。

除以 `sqrt(dk)` 是为了控制点积尺度。若 Q、K 每一维方差近似为 1，`dk` 项相加后点积方差会随 `dk` 增长。数值过大会把 softmax 推向饱和区，梯度变得很小。缩放后，训练更稳定。

## 3 多头 attention 的 shape 到底怎么变

单头 attention 能让 token 之间交换信息，多头 attention 则把 `D` 划成 `H` 个子空间，让不同 head 独立匹配。

设：

```text
D = 32
H = 4
Dh = D / H = 8
```

QKV 投影刚完成时仍然是：

```text
Q/K/V: [B, T, D]
```

接着 reshape 并 transpose：

```python
q = q.view(batch_size, length, n_heads, head_dim).transpose(1, 2)
```

shape 变成：

```text
[B, T, D]
-> [B, T, H, Dh]
-> [B, H, T, Dh]
```

每个 head 独立计算：

```text
Q:             [B, H, T, Dh]
K transpose:   [B, H, Dh, T]
QK^T:          [B, H, T, T]
softmax:       [B, H, T, T]
weights @ V:   [B, H, T, Dh]
```

最后合并所有 heads：

```text
[B, H, T, Dh]
-> [B, T, H, Dh]
-> [B, T, D]
```

这说明 attention 真正新增的关键对象是 `[T, T]`：每个 query token 对每个 key token 的匹配关系。它也是标准 full attention 在长上下文下变贵的来源。

## 4 causal mask：可以回看过去，不能偷看未来

GPT 类 decoder-only 模型遵守的规则不是“不能往回看”，而是：

> 当前位置可以读取自己和过去，不能读取未来。

对序列 `A B C D`，允许关系如下：

```text
          Key
          A  B  C  D
Query A   ✓  ✗  ✗  ✗
Query B   ✓  ✓  ✗  ✗
Query C   ✓  ✓  ✓  ✗
Query D   ✓  ✓  ✓  ✓
```

实现上，在 softmax 前把上三角位置设成负无穷：

```python
mask = torch.triu(torch.ones(T, T, dtype=torch.bool), diagonal=1)
scores = scores.masked_fill(mask, float("-inf"))
weights = softmax(scores, dim=-1)
```

`exp(-inf) = 0`，因此被 mask 的未来位置权重为 0。

当前位置允许看自己不会泄漏答案，因为 next-token training 把输入和目标错开了一位：

```text
input:   a t t e n t i o n
target:  t t e n t i o n _
```

位置 `e` 可以读取输入中的 `e`，但它负责预测的目标 `n` 还没有出现在这个位置可见的上下文里。

这里还有一个对 KV cache 很重要的不变量。正确使用 causal mask 时，第一个 `a` 的 hidden state 不会因为后面增加 token 而改变：

```text
h_a("attention")
= h_a("attention_")
= h_a("attention_l")
```

如果 full-prefix 推理不加 mask，第一个 `a` 会看到后来的 `_` 和 `l`，历史表示会不断变化，已经保存的 KV cache 也就失效了。**Causal mask 不只是防止训练偷看答案，也是历史 KV 可以稳定复用的前提。**

BERT 类 encoder 需要双向上下文，因此不使用这种 causal mask；encoder-decoder Transformer 中，decoder self-attention 使用 causal mask，cross-attention 通常不使用。

## 5 一个完整 Transformer block 还有什么

Attention 只完成 token 之间的信息交换。一个常见的 pre-norm block 还包含 LayerNorm、输出投影、残差连接和 MLP：

```text
X
├─ LayerNorm -> Multi-Head Attention -> Wo ─┐
└───────────────────────────────────────────+ -> R

R
├─ LayerNorm -> Linear(D, 4D) -> GELU -> Linear(4D, D) ─┐
└────────────────────────────────────────────────────────+ -> X(next layer)
```

对应代码是：

```python
x = x + self.output(attended)
x = x + self.mlp(self.norm2(x))
```

Residual connection 要求相加两边 shape 相同，所以 block 的输入输出都保持 `[B, T, D]`。Attention 内部暂时拆成 `[B, H, T, Dh]`，MLP 内部暂时升到 `[B, T, 4D]`，离开子层后都回到 residual stream 的 `D`。

下一层不会直接拿上一层的 Q 当作自己的 Q。它拿到上一层最终输出 `X(l+1)`，再使用自己独立的 `Wq/Wk/Wv` 产生全新的 QKV：

```text
Q(l+1) = X(l+1) Wq(l+1)
K(l+1) = X(l+1) Wk(l+1)
V(l+1) = X(l+1) Wv(l+1)
```

层越深，`X(l)` 越不是原始 embedding，而是已经吸收上下文的 token 表示。

## 6 训练：loss、反向传播与 AdamW 分别负责什么

训练步骤可以拆成四件事：

```python
optimizer.zero_grad()
logits, loss, _ = model(inputs, targets)
loss.backward()
optimizer.step()
```

它们的职责不能混在一起：

```text
model(inputs)      参数 -> 预测 logits
loss               衡量预测与目标相差多少
loss.backward()    计算每个参数对 loss 的梯度
optimizer.step()   使用梯度更新参数
```

### 6.1 反向传播只计算梯度

前向传播期间，PyTorch 记录计算图：

```text
Wq -> Q -> scores -> weights -> hidden -> logits -> loss
```

调用 `loss.backward()` 后，autograd 按链式法则反向遍历，计算：

```text
d(loss)/d(Wq)
d(loss)/d(Wk)
d(loss)/d(Wv)
d(loss)/d(embedding)
...
```

结果写到每个 `Parameter.grad`。这一步不需要 optimizer，因为求导规则只由计算图决定，与稍后选择 SGD、AdamW 还是其他优化器无关。它也不会修改参数值。

### 6.2 optimizer 为什么知道模型参数

创建 AdamW 时已经把模型参数对象交给了它：

```python
optimizer = torch.optim.AdamW(model.parameters(), lr=3e-3)
```

Optimizer 保存的是这些 `Parameter` 的引用。`loss.backward()` 把梯度写入同一个对象的 `.grad`，`optimizer.step()` 再遍历这些引用、读取 `.grad` 并修改参数。

`zero_grad()` 同样重要。PyTorch 默认累加梯度，如果不清理，当前 batch 的梯度会叠加到上一轮。

### 6.3 AdamW 比 SGD 多保存了什么

最简单的 SGD 是：

```text
theta_new = theta_old - learning_rate * gradient
```

AdamW 对每个参数维护两个同 shape 状态：

```text
m_t = beta1 * m_(t-1) + (1-beta1) * g_t
v_t = beta2 * v_(t-1) + (1-beta2) * g_t^2
```

经过初始偏差修正后，用一阶动量除以二阶动量的平方根：

```text
theta <- theta - lr * m_hat / (sqrt(v_hat) + epsilon)
```

AdamW 还把 weight decay 与梯度自适应缩放解耦：

```text
theta <- (1 - lr * weight_decay) * theta
```

因此每个参数对象附近可以看到：

```text
parameter.data   当前权重
parameter.grad   当前 batch 的梯度
exp_avg          Adam 一阶动量 m
exp_avg_sq       Adam 二阶动量 v
step             更新步数
```

Tiny Transformer 的真实输出验证了 shape 对齐：

```text
Wq / Adam m / Adam v: (32, 32) each
```

Optimizer state 通常在第一次 `step()` 时按参数 shape 懒初始化。Q、K、V activation 不会被 AdamW 保存；被保存的是产生它们的 `Wq/Wk/Wv` 参数及对应的 `m/v`。

### 6.4 为什么训练 checkpoint 比推理权重大

若参数使用 FP32，每个参数占 4 bytes。AdamW 的 `m` 和 `v` 各占 4 bytes，训练运行时通常还有 4 bytes 的 gradient：

```text
model parameter theta   4 bytes / parameter
gradient g              4 bytes / parameter
Adam m                  4 bytes / parameter
Adam v                  4 bytes / parameter
```

仅运行时这些核心对象就约 16 bytes/parameter，还没有算 activation、临时 buffer 和分布式通信空间。普通训练 checkpoint 常保存 `theta + m + v`，因此可能约为纯 FP32 模型权重的三倍；混合精度训练还可能存在 FP32 master weights。

发布具体 optimizer state 对精确恢复原预训练轨迹有意义，但对推理和常规微调通常没有必要。后者改变了数据、loss、learning rate 或可训练参数，往往重新初始化 optimizer。相比之下，开源 optimizer 算法、训练代码和配置仍然很重要，因为它们决定模型如何走到最终权重。

示例的真实训练结果是：

```text
step   0 | loss 3.0856
step 100 | loss 0.4779
step 200 | loss 0.0615
step 300 | loss 0.0312
```

它只是在重复字符语料上验证计算链路，不代表模型质量；能够得到的结论是 backward 与 optimizer 确实让 next-token loss 持续下降。

## 7 推理为什么像 RNN，却仍然不是 RNN

自回归生成确实是一个循环：

```text
prompt -> logits -> sample token_1
token_1 -> logits -> sample token_2
token_2 -> logits -> sample token_3
```

用户看到的 streaming 响应也通常来自这个过程。不过网络层不保证每个 chunk 恰好对应一个 token：服务端可以合并多个 token 再发送，speculative decoding 也可以一次提出并验证多个候选 token。

上一步采样出的 token ID 会成为下一步输入，但不会把全部历史文本重新 tokenize。推理服务器内部保留已经确认的 token IDs 和 KV cache。

它与 RNN 的相似点是“旧状态 + 新输入 -> 新状态 + 输出”。区别在于状态结构：

```text
RNN:
h_t = f(h_(t-1), x_t)
历史被压缩进固定大小 h_t

Transformer decode:
cache_t = cache_(t-1) append (K_t, V_t)
Q_t queries all cached K/V
历史状态随 T 线性增长
```

RNN 沿时间步训练存在严格依赖；Transformer 训练可以借助 causal mask 并行计算全部位置。标准 Transformer decode 每一步仍要让新 Q 读取历史 K，单步 attention 成本随上下文增长。它在推理执行上有 recurrence，但模型结构不是传统固定状态 RNN。

KDA、linear attention 等机制把历史压缩进固定或近固定大小的 recurrent state，在数学形式上比标准 softmax attention 更接近 RNN。

## 8 KV cache 为什么只缓存 K/V，而且每层都要缓存

如果没有 cache，生成每个新 token 都要把完整前缀重新送进模型：

```text
attention
attention_
attention_l
attention_le
```

历史 token 的 K/V 每一步都相同，重复计算没有价值。KV cache 在 prompt prefill 后保存每层的历史 K/V；随后每一步只输入一个新 token：

```text
new token x_t
-> compute q_t, k_t, v_t in layer 1
-> q_t reads layer-1 cached K/V
-> append k_t, v_t to layer-1 cache
-> layer-1 output enters layer 2
-> repeat with layer-2 cache
```

为什么不缓存 Q？因为 Q 是一次性的查询。`q_t` 在第 t 步读取完历史后，未来第 `t+1` 步使用的是新的 `q_(t+1)`。但 `k_t/v_t` 以后还要继续被所有新 query 匹配和读取。

```text
Q：一次性的搜索请求
K：以后还要使用的索引
V：以后还要读取的内容
```

多层模型中，每层输入和 `Wk/Wv` 不同，所以每层都必须保存独立 cache：

```python
next_cache = []
for layer_index, block in enumerate(self.blocks):
    layer_cache = None if past_kv is None else past_kv[layer_index]
    x, present_kv = block(x, layer_cache, use_cache=True)
    next_cache.append(present_kv)
```

每层 K/V 的常见 shape 是：

```text
[B, Hkv, cached_tokens, Dh]
```

整个模型可以概念化为：

```text
L x (K, V)
K/V: [B, Hkv, T, Dh]
```

Tiny Transformer 有两层，运行输出为：

```text
layers cached: 2
layer 0 K/V: (1, 4, 48, 8) each
```

KV cache 字节数近似为：

```text
2 * L * B * T * Hkv * Dh * bytes_per_element
```

前面的 `2` 代表 K 和 V。它随层数、batch、上下文长度线性增长，因此长上下文和高并发推理会迅速消耗 HBM。

KV cache 省掉的是历史 token 经过各层和 K/V projection 的重复计算。它没有消除新 Q 对历史 K 的 attention；标准 attention 的 decode 每步仍需读取不断增长的历史。

## 9 prefill、decode 与 mask 的边界

推理分成两个阶段。

### 9.1 Prefill

第一次接收完整 prompt 时，模型并行处理全部输入 token：

```text
input:      [B, T]
Q/K/V:      [B, H, T, Dh]
scores:     [B, H, T, T]
KV cache:   every layer gets K/V for T positions
```

Prefill 必须使用 causal mask，因为 prompt 中所有位置同时存在。只有这样，前面 token 的 layer output 才不会读取后面的 token，生成出来的每层 K/V 才能作为稳定历史缓存。

Prefill 通常是大矩阵乘法，更接近 compute-bound。用户从提交请求到看到第一个 token 的时间通常记作 TTFT，即 Time To First Token。

### 9.2 Decode

Prefill 后，每一步通常只输入一个新 token：

```text
input:      [B, 1]
new Q/K/V:  [B, H, 1, Dh]
cached K/V: [B, Hkv, T, Dh]
scores:     [B, H, 1, T+1]
```

这时 cache 里只有过去和当前，没有未来，因此单 token decode 的 causal mask 行全部允许，mask 在数学上没有实际屏蔽效果。实现仍可统一保留 mask；如果一次 decode 多个 token，或者 batch 里还有 padding/不同有效长度，mask 仍然有作用。

Decode 的矩阵较小，每一步却要读取模型权重和大量 KV，通常更受内存带宽限制。相邻输出 token 的延迟常记作 TPOT 或 ITL。

### 9.3 Cache 等价性

示例分别运行完整前缀和逐 token cached forward，得到：

```text
full vs cached max logits difference: 0.00000489
```

这一级差异来自浮点矩阵计算顺序；两条路径在语义上等价。这个实验同时验证了位置索引、causal mask 切片和逐层 cache 拼接没有错位。

## 10 Agent、1M context 与 prefix cache

Claude Code、Codex 一类 Agent 的模型输入通常不只有用户刚输入的一句话，而是：

```text
system prompt
+ tool definitions
+ project instructions
+ conversation history
+ previous tool calls/results
+ current user input
```

同一次生成中，这些 token 都会经历 prefill 并形成逐层 KV cache。跨多次模型调用，服务端还可能复用相同前缀的 prompt/prefix cache：

```text
cached exact prefix + newly appended suffix
```

这也是 causal 结构带来的能力：后缀不会改变前缀的 K/V。但跨请求命中通常要求模型版本、tokenization、前缀 token 顺序、工具定义和相关推理配置一致。外部只能确认“prompt cache 命中”语义，不能凭 Agent 框架断言具体服务端一定把原始 GPU KV 以某种形式长期保存。

因此“Agent 每轮只计算用户输入”也不够准确。真正需要新算的后缀还可能包括：

- 新的用户 token；
- 工具返回内容；
- 新读入的文件；
- 上一轮模型生成的 token；
- context compaction 后发生变化的部分。

所谓 `1M context` 指 sequence length `T`，不是 hidden dimension `D`：

```text
X: [B, T, D]
T <= 1,000,000
```

它的预算通常由 system、tools、history、user input 和 output 共同占用。Prompt cache 可以减少重复计算、传输或计费，不会把模型的理论 context window 变大。

标准 full attention 的分数在概念上是：

```text
[B, H, T, T]
```

当 `T = 1,000,000` 时，完整物化这个矩阵不可行。FlashAttention 可以避免把完整分数矩阵写入 HBM，但标准 full attention 的计算规模仍然是二次的。长上下文模型还会结合 GQA、滑动窗口、稀疏 attention、linear attention 或其他混合结构。

## 11 MaaS 一次能服务多少请求

MaaS 不应只用“一个 batch 放多少用户”衡量容量，因为请求长度差异很大：20-token prompt 与 100K-token prompt 都算一个请求，但成本完全不同。

现代推理系统通常采用 continuous batching。每个 scheduling cycle 都可以移除完成的请求、加入新请求，并分别安排 prefill chunk 与 decode token。

![MaaS 调度器按 batched tokens、活跃序列和 KV blocks 组成 continuous batch，GPU HBM 保存活跃 KV，并可与 RDMA NVMe 共享容量层迁移](https://img.f3dlife.com/blog/2026/07/20/maas-kv-cache-526304a0-e6c6-4e16-9a69-b094f815f854.png)
Fig. 服务容量不是固定用户数：调度器同时受 token budget、KV block、序列数与 TTFT/TPOT 约束；共享存储适合 warm KV 的迁移和复用，活跃 decode 仍依赖 HBM。

一次调度至少受四类约束：

1. `max_num_batched_tokens`：本轮允许计算多少 token；
2. `max_num_seqs`：最多维护多少活跃序列；
3. 可用 KV blocks：现有和预期输出能否继续占用 HBM；
4. 服务目标：TTFT、TPOT、吞吐与 P99 latency。

Decode 阶段每条普通序列本轮通常只贡献一个新 query token；prefill 请求可能一次贡献几千 token。Chunked prefill 会把长 prompt 拆成较小块，避免一条 100K prompt 长时间阻塞正在 streaming 的请求。

可以把简化调度器写成：

```python
token_budget = max_num_batched_tokens
sequence_budget = max_num_seqs
kv_budget = available_kv_blocks

schedule_decode_tokens_first()
fill_remaining_budget_with_prefill_chunks()
```

真实调度还要考虑 prefix cache locality、请求优先级、LoRA adapter、speculative decoding、租户配额和 GPU 拓扑。

训练里的 global batch 又是另一回事：

```text
global batch
= micro batch per device
* data parallel workers
* gradient accumulation steps
```

它影响优化轨迹；推理 continuous batch 则主要围绕吞吐、延迟和 KV 容量动态变化。

## 12 KV cache 能不能放到外部存储

可以，但要区分“容量层”和“活跃计算层”。合理的分层通常是：

```text
L0  GPU HBM
    正在 decode 的热 KV

L1  CPU DRAM / CXL
    本机温数据或临时 spill

L2  RDMA + NVMe/JBOF shared store
    prefix cache、PD transfer、session resume、被驱逐 KV
```

XSKY 在 2026 年 7 月发布的 [MeshFusion KV Cache 评测说明](https://hp.xsky.com/about/news/info/id/1046.html) 中，披露了三类部署形态：复用 GPU/NPU 服务器本地 NVMe 并通过 RDMA 组成共享池、BlueField-3 DPU + JBOF、独立存储集群。页面还覆盖了 PD 一体与 PD 分离、GPUDirect RDMA、`NixlConnector` 和 MeshFusion SDK。

该页面报告的测试结果包括：集群 EC 顺序读 `272.1 GiB/s`，单客户端顺序读 `167.0 GiB/s`；在其特定模型、硬件和负载下，warm KV 命中相对 cold recompute 显著降低 TTFT 并提高吞吐。这些数字来自厂商发布的 ODCC 联合评测总结，适合证明技术路线和候选部署形态，不应直接外推为任意业务的容量承诺。

外部 KV store 最适合三类路径：

1. 相同 system/tool prefix 被多个 Agent 请求复用；
2. Prefill 节点把每层 KV 交给 Decode 节点；
3. 暂停会话从 HBM spill，恢复时重新加载。

它通常不能直接替代活跃 decode 所需的 HBM。每生成一个 token，每层都要低延迟读取历史 K/V；远端存储即使有数百 GiB/s，和 GPU HBM 的延迟、带宽与 kernel 访问路径仍不在同一层级。合理路径是批量把 warm KV 载入本地 HBM，再进入高频 decode。

选型的核心不应是“存储带宽看起来很高”，而是比较：

```text
KV load time < prefix recompute time
KV load time + queue time < TTFT SLO
```

还要验证真实请求分布下的 cache hit ratio、随机读 P99、KV 对象大小、写入放大、模型并行布局兼容性，以及多租户隔离、加密、TTL 和 cache invalidation。

## 13 现代 attention 与 MoE 的关系

MoE 与 attention 是两个独立维度：

```text
Attention：当前 token 从哪些 token 读取信息？
MoE Router：当前 token 交给哪些 FFN experts 处理？
```

主流 MoE 通常把 dense FFN 换成 routed experts，但这不意味着 attention 必须保持 2017 年原始形式。现代模型会从不同方向改写它：

| 机制 | 主要改变 |
| --- | --- |
| GQA/MQA | 减少 KV heads，让多个 query heads 共享 K/V，直接缩小 KV cache |
| MLA | 压缩 QKV 参数化与 KV 表示，重点降低推理 cache 成本 |
| MSA | 先用 index branch 选择相关 KV blocks，再在选中区域做精确 softmax attention |
| KDA/linear attention | 用递归状态或 kernelized 结构避免显式完整 `T x T` attention |

因此原始 scaled dot-product attention 仍然是理解这些架构的坐标原点，但不是所有前沿模型的最终执行形式。

例如 MiniMax Sparse Attention 的公开论文把过程明确拆成两步：Index Branch 为每个 GQA group 选择 Top-K KV blocks，Main Branch 只对这些 block 执行 scaled dot-product softmax attention。DeepSeek MLA 的重点则是 latent compression 与 KV cache 参数化。两者都仍能使用 Q/K/V 的“查询、匹配、读取”语言解释，却改动了不同层级。

## 14 最终工作模型

把全文压缩成一条控制流，可以得到下面这组不容易混淆的边界。

训练阶段：

```text
text
-> token IDs [B, T]
-> embedding X [B, T, D]
-> every layer builds Q/K/V
-> causal multi-head attention
-> residual + MLP
-> logits [B, T, V]
-> shifted next-token loss
-> backward writes parameter.grad
-> AdamW reads grad, updates m/v and model parameters
```

推理阶段：

```text
prompt
-> prefill with causal mask
-> build K/V cache for every layer
-> sample one token
-> feed only the new token ID
-> new Q reads historical K/V
-> append new K/V to every layer cache
-> repeat and stream output
```

系统阶段：

```text
request router
-> continuous batching by token/KV budgets
-> prefill and decode scheduling
-> active KV stays in GPU HBM
-> reusable or inactive KV may move through RDMA to a shared capacity tier
```

最核心的结论不是某一条公式，而是三个对象的生命周期：

- 模型参数长期存在，被 backward 产生的梯度和 optimizer 更新；
- Q 是当前 token 的一次性查询，完成本步 attention 后不再复用；
- K/V 是未来 token 仍需读取的历史，因此在推理时按层缓存，并最终成为 MaaS 的主要容量与调度对象。

从这里再看 1M context、Agent prefix cache、PD 分离和 KV 存储，它们不再是突然出现的系统名词，而是同一条 causal token 路径在规模扩大后的直接结果。

## 参考资料

- Vaswani et al., [Attention Is All You Need](https://arxiv.org/abs/1706.03762), 2017.
- PyTorch, [AdamW documentation](https://docs.pytorch.org/docs/stable/generated/torch.optim.AdamW.html).
- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180), 2023.
- Dao et al., [FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135), 2022.
- DeepSeek-AI, [DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model](https://arxiv.org/abs/2405.04434), 2024.
- MiniMax, [MiniMax Sparse Attention](https://arxiv.org/abs/2606.13392), 2026.
- Moonshot AI, [Kimi K3: Open Frontier Intelligence](https://www.kimi.com/fr-fr/blog/kimi-k3), 2026.
- XSKY, [ODCC 携手 NVIDIA、XSKY 等发布 KV Cache 全场景测评报告](https://hp.xsky.com/about/news/info/id/1046.html), 2026.
