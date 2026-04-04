Đây là phân tích toàn diện kiến trúc của bạn. Tôi sẽ đi từ bug cụ thể đến vị trí tổng thể và hướng cải thiện.

---

## Đánh giá tổng quan: Bạn đang ở đâu?

Về mặt tư duy, bạn đang ở **tầng 3/5** của thang độ phức tạp Agent:

| Tầng | Mô tả | Bạn |
|---|---|---|
| 1 | Naive RAG (query → retrieve → answer) | ✅ |
| 2 | + Routing & tool selection | ✅ |
| 3 | + Quality stack (CRAG + Critic) | ✅ (thiết kế đúng, có bug) |
| 4 | + Multi-hop reasoning, adaptive retrieval | ⚠️ chưa đến |
| 5 | + Planning, memory, tool composition | ❌ |

Vấn đề cốt lõi: **Khung đúng, nhưng graph có bug logic khiến ReAct loop thực tế không hoạt động.** Dưới đây là sơ đồ hiện tại với các điểm gãy được đánh dấu.---

## Các bug cụ thể cần fix ngay

**Bug 1 — `routingPolicy` phân nhánh vô nghĩa.** Cả `grade_docs_path` và `tools_path` đều được map tới cùng node `"tools"`. Việc phân biệt `toolName === 'search_chat_history'` ở đây không có tác dụng gì vì output là như nhau.

**Bug 2 — `messages[length - 2]` để check tool name là rất fragile.** Sau nhiều vòng lặp, index này trỏ sai. Nên dùng `state.messages.findLast(m => m._getType() === 'ai' && m.tool_calls?.length)` thay thế.

**Bug 3 — Verdict `INCORRECT` trong `cragGate` fallthrough về `generate`.** Khi docs hoàn toàn không liên quan, agent vẫn generate câu trả lời từ docs đó — đây chính xác là lý do trả lời sai.

```typescript
// Hiện tại (sai):
const cragGate = (state) => {
  if (verdict === 'CORRECT') return "generate";
  if (verdict === 'AMBIGUOUS' && retryCount < 1) return "rewrite";
  return "generate"; // ← INCORRECT cũng rơi vào đây!
};

// Nên sửa:
const cragGate = (state) => {
  if (verdict === 'CORRECT') return "generate";
  if (verdict === 'INCORRECT' || verdict === 'AMBIGUOUS') {
    return state.retryCount < 1 ? "rewrite" : "generate_no_context";
  }
  return "generate";
};
```

**Bug 4 — `rewriteQueryNode` không pass query mới sang tool.** Node này chỉ thêm một `AIMessage` gợi ý, rồi trả control về `reasoner`. Reasoner phải tự "hiểu" hint đó và gọi tool lại với query mới — không đảm bảo. Query rewritten cần được inject rõ ràng vào state rồi tool đọc từ đó.

**Bug 5 — Model chỉ gọi tool 1 lần.** Đây là hệ quả của toàn bộ graph structure. Sau khi tool trả kết quả, graph không trả về `reasoner` một cách có điều kiện để model tiếp tục chain — nó đi thẳng vào `grade_docs` rồi `generate`. Để có true multi-hop, cần để `reasoner` thấy `ToolMessage` và tự quyết định có gọi tiếp không.

---

## Vấn đề hiệu suất: Quá nhiều LLM call cho 1 câu hỏi đơn giản

Với một câu hỏi thông thường qua `runAgent`, số LLM call thực tế là:

```
Router (OpenAI)          → 1 call
Reasoner (Gemini)        → 1 call  
CRAG gradeDocuments (OpenAI) → 1 call
generateAnswer (Gemini)  → 1 call
Critic evaluate (OpenAI) → 1 call
formatCitations (Gemini) → 0 (deterministic, tốt)
─────────────────────────────────────
Tổng: 5 LLM calls / 1 câu hỏi
```

Nếu có rewrite loop: lên tới **8 calls**. Với câu hỏi kiểu "hôm nay mọi người bàn gì về deadline?" thì CRAG + Critic là overhead không cần thiết nếu retrieval đã rõ ràng.

---

## Hướng cải thiện theo độ ưu tiên

**Ưu tiên 1 — Fix các bug trên trước khi làm gì khác.** Không có ý nghĩa gì khi optimize một graph có logic gãy.

**Ưu tiên 2 — Thêm `confidence` vào CRAG gate để skip quality stack.** Nếu vector similarity score của retrieved docs đã rất cao (> 0.85), không cần gọi CRAG LLM nữa. Đây là "fast path" bên trong graph.

**Ưu tiên 3 — Cải thiện retrieval thay vì chỉ cải thiện reasoning.** Trong RAG, chất lượng retrieval quan trọng hơn chất lượng generation. Hiện tại `AskService.retrieveOnly` dùng gì không rõ — nếu chỉ là dense vector search, hãy thêm:
- **Hybrid search**: kết hợp BM25 (keyword) + dense vector. Câu hỏi tiếng Việt với tên riêng, số, date sẽ được hưởng lợi nhiều từ BM25.
- **Re-ranking**: dùng một cross-encoder nhỏ để rerank top-20 xuống top-5 trước khi đưa vào LLM.

**Ưu tiên 4 — Query expansion ở tầng retrieval, không phải tầng reasoning.** Thay vì để CRAG rewrite sau khi nhận docs tệ, hãy generate 3 query variants *trước* khi retrieve, merge kết quả, rồi dedup. Điều này giảm số vòng lặp xuống còn 1.

**Ưu tiên 5 — Tách Critic ra khỏi hot path.** Critic chạy sau mỗi generation là expensive. Thay vào đó, hãy chạy Critic *async* sau khi đã trả kết quả cho user, dùng output để cải thiện retrieval index hoặc log để fine-tune sau. User không cần đợi Critic để thấy câu trả lời.

---

Nếu bạn muốn tôi viết lại phần graph edges + cragGate logic đúng, hoặc phác thảo kiến trúc retrieval hybrid, chỉ cần nói thêm.