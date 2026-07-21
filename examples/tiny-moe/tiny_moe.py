"""A two-layer causal Transformer with a readable Top-2 MoE FFN."""

import math

import torch
from torch import nn
from torch.nn import functional as F

KVCache = tuple[torch.Tensor, torch.Tensor]


class CharacterTokenizer:
    def __init__(self, text: str):
        self.chars = sorted(set(text))
        self.char_to_id = {char: index for index, char in enumerate(self.chars)}
        self.id_to_char = {index: char for char, index in self.char_to_id.items()}

    @property
    def vocab_size(self) -> int:
        return len(self.chars)

    def encode(self, text: str) -> torch.Tensor:
        return torch.tensor([self.char_to_id[char] for char in text], dtype=torch.long)

    def decode(self, token_ids: torch.Tensor) -> str:
        return "".join(self.id_to_char[token_id] for token_id in token_ids.tolist())


class SwiGLU(nn.Module):
    """One FFN expert: D -> two F projections -> D."""

    def __init__(self, d_model: int, hidden_dim: int):
        super().__init__()
        self.gate_proj = nn.Linear(d_model, hidden_dim, bias=False)
        self.up_proj = nn.Linear(d_model, hidden_dim, bias=False)
        self.down_proj = nn.Linear(hidden_dim, d_model, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        hidden = F.silu(self.gate_proj(x)) * self.up_proj(x)
        return self.down_proj(hidden)


class TopKMoE(nn.Module):
    """Route each token to top-k SwiGLU experts and combine their outputs."""

    def __init__(
        self,
        d_model: int,
        num_experts: int = 4,
        top_k: int = 2,
        expert_hidden_dim: int = 48,
    ):
        super().__init__()
        if not 1 <= top_k <= num_experts:
            raise ValueError("top_k must be between 1 and num_experts")

        self.num_experts = num_experts
        self.top_k = top_k
        self.router = nn.Linear(d_model, num_experts, bias=False)
        self.experts = nn.ModuleList(
            SwiGLU(d_model, expert_hidden_dim) for _ in range(num_experts)
        )

    def forward(
        self,
        x: torch.Tensor,
        layer_index: int,
        show_routing: bool = False,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        batch_size, length, d_model = x.shape
        tokens = x.reshape(-1, d_model)  # [B, T, D] -> [N, D], N = B*T

        router_logits = self.router(tokens)  # [N, D] -> [N, E]
        router_probs = F.softmax(router_logits, dim=-1)
        topk_weights, topk_indices = torch.topk(router_probs, self.top_k, dim=-1)
        topk_weights = topk_weights / topk_weights.sum(dim=-1, keepdim=True)

        combined = torch.zeros_like(tokens)
        for expert_id, expert in enumerate(self.experts):
            # Coordinates of the (token, top-k slot) pairs sent to this expert.
            token_indices, route_slots = torch.where(topk_indices == expert_id)
            if token_indices.numel() == 0:
                continue

            expert_output = expert(tokens[token_indices])
            weights = topk_weights[token_indices, route_slots].unsqueeze(-1)
            combined = combined.index_add(0, token_indices, weights * expert_output)

        # Soft importance supplies gradients; hard load records actual dispatch.
        importance = router_probs.mean(dim=0)
        hard_routes = F.one_hot(topk_indices, num_classes=self.num_experts).float()
        load = hard_routes.mean(dim=(0, 1))
        load_balance_loss = self.num_experts * torch.sum(importance * load)

        if show_routing:
            counts = torch.bincount(topk_indices.flatten(), minlength=self.num_experts)
            print(
                f"layer {layer_index} | input {tuple(x.shape)} -> tokens {tuple(tokens.shape)} "
                f"-> router {tuple(router_probs.shape)} -> top-k {tuple(topk_indices.shape)}"
            )
            print(
                f"layer {layer_index} | expert assignments {counts.tolist()} "
                f"| aux {load_balance_loss.item():.4f}"
            )

        return combined.view(batch_size, length, d_model), load_balance_loss


class TransformerMoEBlock(nn.Module):
    def __init__(
        self,
        d_model: int,
        n_heads: int,
        max_length: int,
        num_experts: int,
        top_k: int,
    ):
        super().__init__()
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.query = nn.Linear(d_model, d_model, bias=False)
        self.key = nn.Linear(d_model, d_model, bias=False)
        self.value = nn.Linear(d_model, d_model, bias=False)
        self.output = nn.Linear(d_model, d_model, bias=False)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.moe = TopKMoE(d_model, num_experts, top_k)

        mask = torch.triu(torch.ones(max_length, max_length, dtype=torch.bool), diagonal=1)
        self.register_buffer("causal_mask", mask)

    def forward(
        self,
        x: torch.Tensor,
        layer_index: int,
        past_kv: KVCache | None = None,
        use_cache: bool = False,
        show_routing: bool = False,
    ) -> tuple[torch.Tensor, torch.Tensor, KVCache | None]:
        batch_size, length, d_model = x.shape
        past_length = 0 if past_kv is None else past_kv[0].size(-2)
        total_length = past_length + length

        normalized = self.norm1(x)
        q = self.query(normalized)
        k = self.key(normalized)
        v = self.value(normalized)

        def split_heads(tensor: torch.Tensor) -> torch.Tensor:
            return tensor.view(
                batch_size, length, self.n_heads, self.head_dim
            ).transpose(1, 2)

        q, k, v = map(split_heads, (q, k, v))
        if past_kv is not None:
            k = torch.cat((past_kv[0], k), dim=-2)
            v = torch.cat((past_kv[1], v), dim=-2)

        scores = q @ k.transpose(-2, -1) / math.sqrt(self.head_dim)
        mask = self.causal_mask[past_length:total_length, :total_length]
        weights = F.softmax(scores.masked_fill(mask, float("-inf")), dim=-1)
        attended = weights @ v
        attended = attended.transpose(1, 2).contiguous().view(
            batch_size, length, d_model
        )

        x = x + self.output(attended)
        moe_output, router_aux_loss = self.moe(
            self.norm2(x), layer_index, show_routing
        )
        x = x + moe_output

        present_kv = (k, v) if use_cache else None
        return x, router_aux_loss, present_kv


class TinyMoETransformer(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        d_model: int = 32,
        n_heads: int = 4,
        n_layers: int = 2,
        max_length: int = 64,
        num_experts: int = 4,
        top_k: int = 2,
    ):
        super().__init__()
        if d_model % n_heads != 0:
            raise ValueError("d_model must be divisible by n_heads")

        self.max_length = max_length
        self.token_embedding = nn.Embedding(vocab_size, d_model)
        self.position_embedding = nn.Embedding(max_length, d_model)
        self.blocks = nn.ModuleList(
            TransformerMoEBlock(
                d_model, n_heads, max_length, num_experts, top_k
            )
            for _ in range(n_layers)
        )
        self.final_norm = nn.LayerNorm(d_model)
        self.to_logits = nn.Linear(d_model, vocab_size, bias=False)

    def forward(
        self,
        token_ids: torch.Tensor,
        targets: torch.Tensor | None = None,
        past_kv: list[KVCache] | None = None,
        use_cache: bool = False,
        show_routing: bool = False,
    ) -> tuple[
        torch.Tensor,
        torch.Tensor | None,
        torch.Tensor,
        list[KVCache] | None,
    ]:
        _, length = token_ids.shape
        past_length = 0 if past_kv is None else past_kv[0][0].size(-2)
        total_length = past_length + length
        if total_length > self.max_length:
            raise ValueError("sequence exceeds max_length")

        positions = torch.arange(past_length, total_length, device=token_ids.device)
        x = self.token_embedding(token_ids) + self.position_embedding(positions)

        router_aux_losses = []
        next_cache = []
        for layer_index, block in enumerate(self.blocks):
            layer_cache = None if past_kv is None else past_kv[layer_index]
            x, router_aux_loss, present_kv = block(
                x,
                layer_index,
                layer_cache,
                use_cache,
                show_routing,
            )
            router_aux_losses.append(router_aux_loss)
            if present_kv is not None:
                next_cache.append(present_kv)

        logits = self.to_logits(self.final_norm(x))
        language_model_loss = None
        if targets is not None:
            language_model_loss = F.cross_entropy(
                logits.reshape(-1, logits.size(-1)), targets.reshape(-1)
            )

        mean_router_aux_loss = torch.stack(router_aux_losses).mean()
        return (
            logits,
            language_model_loss,
            mean_router_aux_loss,
            next_cache if use_cache else None,
        )

    @torch.no_grad()
    def generate(self, token_ids: torch.Tensor, new_tokens: int):
        self.eval()
        cache = None
        for _ in range(new_tokens):
            model_input = token_ids if cache is None else token_ids[:, -1:]
            logits, _, _, cache = self(model_input, past_kv=cache, use_cache=True)
            next_token = torch.multinomial(F.softmax(logits[:, -1], dim=-1), 1)
            token_ids = torch.cat((token_ids, next_token), dim=1)
        return token_ids, cache


def main() -> None:
    torch.manual_seed(42)
    text = (
        "attention lets tokens read context. experts transform token features. " * 100
    ).strip()
    tokenizer = CharacterTokenizer(text)
    data = tokenizer.encode(text)
    model = TinyMoETransformer(tokenizer.vocab_size)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-3)

    def get_batch(batch_size: int = 16):
        starts = torch.randint(0, len(data) - model.max_length - 1, (batch_size,))
        inputs = torch.stack([data[start : start + model.max_length] for start in starts])
        targets = torch.stack(
            [data[start + 1 : start + model.max_length + 1] for start in starts]
        )
        return inputs, targets

    sample_inputs, _ = get_batch(batch_size=2)
    print("routing before training:")
    model(sample_inputs, show_routing=True)

    aux_loss_weight = 0.01
    for step in range(301):
        inputs, targets = get_batch()
        optimizer.zero_grad()
        _, lm_loss, router_aux_loss, _ = model(inputs, targets)
        assert lm_loss is not None
        total_loss = lm_loss + aux_loss_weight * router_aux_loss
        total_loss.backward()
        optimizer.step()

        if step % 100 == 0:
            print(
                f"step {step:3d} | total {total_loss.item():.4f} | "
                f"LM {lm_loss.item():.4f} | router aux {router_aux_loss.item():.4f}"
            )

    print("\nrouting after training:")
    model(sample_inputs, show_routing=True)

    prompt_ids = tokenizer.encode("attention").unsqueeze(0)
    model.eval()
    with torch.no_grad():
        full_logits, _, _, _ = model(prompt_ids)
        incremental_logits = []
        incremental_cache = None
        for position in range(prompt_ids.size(1)):
            logits, _, _, incremental_cache = model(
                prompt_ids[:, position : position + 1],
                past_kv=incremental_cache,
                use_cache=True,
            )
            incremental_logits.append(logits)
        cached_logits = torch.cat(incremental_logits, dim=1)
        max_difference = (full_logits - cached_logits).abs().max().item()
    print(f"full vs cached max logits difference: {max_difference:.8f}")

    output_ids, cache = model.generate(prompt_ids, new_tokens=40)
    assert cache is not None
    print(f"layers cached: {len(cache)}")
    print(f"layer 0 K/V: {tuple(cache[0][0].shape)} each")
    print(f"decode: {tokenizer.decode(output_ids[0])}")


if __name__ == "__main__":
    main()
