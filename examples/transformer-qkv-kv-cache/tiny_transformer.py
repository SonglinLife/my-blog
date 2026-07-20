"""A small decoder-only Transformer with training and per-layer KV caches."""

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


class TransformerBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, max_length: int):
        super().__init__()
        if d_model % n_heads != 0:
            raise ValueError("d_model must be divisible by n_heads")

        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.query = nn.Linear(d_model, d_model, bias=False)
        self.key = nn.Linear(d_model, d_model, bias=False)
        self.value = nn.Linear(d_model, d_model, bias=False)
        self.output = nn.Linear(d_model, d_model, bias=False)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 4 * d_model),
            nn.GELU(),
            nn.Linear(4 * d_model, d_model),
        )
        mask = torch.triu(torch.ones(max_length, max_length, dtype=torch.bool), diagonal=1)
        self.register_buffer("causal_mask", mask)

    def forward(self, x: torch.Tensor, past_kv: KVCache | None = None, use_cache: bool = False):
        batch_size, length, d_model = x.shape
        past_length = 0 if past_kv is None else past_kv[0].size(-2)
        total_length = past_length + length

        normalized = self.norm1(x)
        q = self.query(normalized)
        k = self.key(normalized)
        v = self.value(normalized)

        def split_heads(tensor: torch.Tensor) -> torch.Tensor:
            return tensor.view(batch_size, length, self.n_heads, self.head_dim).transpose(1, 2)

        q, k, v = map(split_heads, (q, k, v))
        if past_kv is not None:
            k = torch.cat((past_kv[0], k), dim=-2)
            v = torch.cat((past_kv[1], v), dim=-2)

        scores = q @ k.transpose(-2, -1) / math.sqrt(self.head_dim)
        mask = self.causal_mask[past_length:total_length, :total_length]
        weights = F.softmax(scores.masked_fill(mask, float("-inf")), dim=-1)
        attended = weights @ v
        attended = attended.transpose(1, 2).contiguous().view(batch_size, length, d_model)

        x = x + self.output(attended)
        x = x + self.mlp(self.norm2(x))
        present_kv = (k, v) if use_cache else None
        return x, present_kv


class TinyTransformer(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        d_model: int = 32,
        n_heads: int = 4,
        n_layers: int = 2,
        max_length: int = 64,
    ):
        super().__init__()
        self.max_length = max_length
        self.token_embedding = nn.Embedding(vocab_size, d_model)
        self.position_embedding = nn.Embedding(max_length, d_model)
        self.blocks = nn.ModuleList(
            TransformerBlock(d_model, n_heads, max_length) for _ in range(n_layers)
        )
        self.final_norm = nn.LayerNorm(d_model)
        self.to_logits = nn.Linear(d_model, vocab_size, bias=False)

    def forward(
        self,
        token_ids: torch.Tensor,
        targets: torch.Tensor | None = None,
        past_kv: list[KVCache] | None = None,
        use_cache: bool = False,
    ):
        _, length = token_ids.shape
        past_length = 0 if past_kv is None else past_kv[0][0].size(-2)
        total_length = past_length + length
        if total_length > self.max_length:
            raise ValueError("sequence exceeds max_length")

        positions = torch.arange(past_length, total_length, device=token_ids.device)
        x = self.token_embedding(token_ids) + self.position_embedding(positions)

        next_cache = []
        for layer_index, block in enumerate(self.blocks):
            layer_cache = None if past_kv is None else past_kv[layer_index]
            x, present_kv = block(x, layer_cache, use_cache)
            if present_kv is not None:
                next_cache.append(present_kv)

        logits = self.to_logits(self.final_norm(x))
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.reshape(-1, logits.size(-1)), targets.reshape(-1))
        return logits, loss, next_cache if use_cache else None

    @torch.no_grad()
    def generate(self, token_ids: torch.Tensor, new_tokens: int):
        self.eval()
        cache = None
        for _ in range(new_tokens):
            model_input = token_ids if cache is None else token_ids[:, -1:]
            logits, _, cache = self(model_input, past_kv=cache, use_cache=True)
            next_token = torch.multinomial(F.softmax(logits[:, -1], dim=-1), 1)
            token_ids = torch.cat((token_ids, next_token), dim=1)
        return token_ids, cache


def main() -> None:
    torch.manual_seed(42)
    text = ("attention lets each token read useful earlier tokens. " * 100).strip()
    tokenizer = CharacterTokenizer(text)
    data = tokenizer.encode(text)
    model = TinyTransformer(tokenizer.vocab_size)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-3)

    def get_batch(batch_size: int = 16):
        starts = torch.randint(0, len(data) - model.max_length - 1, (batch_size,))
        inputs = torch.stack([data[start : start + model.max_length] for start in starts])
        targets = torch.stack([data[start + 1 : start + model.max_length + 1] for start in starts])
        return inputs, targets

    for step in range(301):
        inputs, targets = get_batch()
        optimizer.zero_grad()
        _, loss, _ = model(inputs, targets)
        assert loss is not None
        loss.backward()
        optimizer.step()
        if step % 100 == 0:
            print(f"step {step:3d} | loss {loss.item():.4f}")

    prompt_ids = tokenizer.encode("attention").unsqueeze(0)
    query_weight = model.blocks[0].query.weight
    query_state = optimizer.state[query_weight]
    print(f"Wq / Adam m / Adam v: {tuple(query_weight.shape)} each")
    assert query_state["exp_avg"].shape == query_weight.shape
    assert query_state["exp_avg_sq"].shape == query_weight.shape

    model.eval()
    with torch.no_grad():
        full_logits, _, _ = model(prompt_ids)
        incremental_logits = []
        incremental_cache = None
        for position in range(prompt_ids.size(1)):
            logits, _, incremental_cache = model(
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
