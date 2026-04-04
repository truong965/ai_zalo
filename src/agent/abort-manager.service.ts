import { Injectable, Logger } from '@nestjs/common';

/**
 * TTL (ms) cho conversation-level cancel flag.
 * Đủ lâu để chặn job retry/duplicate vào queue trong vòng vài giây sau cancel.
 */
const CONVERSATION_CANCEL_TTL_MS = 10_000; // 10 giây

@Injectable()
export class AbortManagerService {
  private readonly logger = new Logger(AbortManagerService.name);
  private abortControllers: Map<string, AbortController> = new Map();

  /**
   * Track các conversation đã bị cancel kèm timestamp hết hạn.
   * Dùng để chặn BullMQ jobs tiếp theo NGAY CẢ KHI chúng dùng requestId mới.
   */
  private cancelledConversations: Map<string, number> = new Map();

  register(requestId: string, controller: AbortController): void {
    this.abortControllers.set(requestId, controller);
  }

  abort(requestId: string, conversationId?: string): void {
    if (!requestId) return;

    const controller = this.abortControllers.get(requestId);
    if (controller) {
      this.logger.log(`Aborting AI request: ${requestId}`);
      controller.abort();
      // DO NOT delete here. It will be removed in agent execution finally block.
    }

    // Mark conversation as cancelled để chặn jobs tiếp theo trong queue
    if (conversationId) {
      const expiresAt = Date.now() + CONVERSATION_CANCEL_TTL_MS;
      this.cancelledConversations.set(conversationId, expiresAt);
      this.logger.debug(
        `Conversation ${conversationId} marked as cancelled for ${CONVERSATION_CANCEL_TTL_MS}ms`,
      );

      // Tự xóa sau TTL để tránh memory leak
      setTimeout(() => {
        const exp = this.cancelledConversations.get(conversationId);
        if (exp && exp <= Date.now()) {
          this.cancelledConversations.delete(conversationId);
          this.logger.debug(`Conversation cancel flag expired: ${conversationId}`);
        }
      }, CONVERSATION_CANCEL_TTL_MS);
    }
  }

  /**
   * Kiểm tra xem conversation có đang trong trạng thái cancelled không.
   * Dùng ở đầu runAgent() để skip ngay lập tức nếu user đã cancel.
   */
  isConversationCancelled(conversationId: string): boolean {
    const expiresAt = this.cancelledConversations.get(conversationId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.cancelledConversations.delete(conversationId);
      return false;
    }
    return true;
  }

  /**
   * Xóa cancel flag ngay (dùng khi job mới thực sự được intentionally gửi bởi user).
   */
  clearConversationCancel(conversationId: string): void {
    this.cancelledConversations.delete(conversationId);
  }

  remove(requestId: string): void {
    if (!requestId) return;
    this.abortControllers.delete(requestId);
  }

  get(requestId: string): AbortController | undefined {
    return this.abortControllers.get(requestId);
  }
}
